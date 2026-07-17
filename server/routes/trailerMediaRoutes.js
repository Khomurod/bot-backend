/**
 * Signed delivery of database-backed Trailer Department media.
 *
 * Telegram cannot present an admin session, so this route is UNAUTHENTICATED
 * but gated entirely by a short-lived HMAC signature bound to the media id, its
 * content version, and an expiry. It is the exact shape of
 * server/routes/routeScreenshotMediaRoutes.js, which already serves screenshots
 * to Telegram in production.
 *
 * Guarantees (all required — a database-backed file must NEVER be reachable
 * through a permanent or unsigned public URL):
 *   - a valid, unexpired signature or nothing is served;
 *   - the ?v content version must still match, so a REPLACED file 404s instead
 *     of serving stale bytes to an old link;
 *   - no caching, ever;
 *   - the URL and its query string are never logged.
 *
 * Admin previews are separate and authenticated (the Trailer Department routes).
 */
'use strict';

const express = require('express');

const { verifyTrailerMediaReference, mediaVersion } = require('../../services/trailerStorage/mediaReference');

/** Types safe to serve inline. Anything else downloads as an opaque blob. */
const INLINE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

function createTrailerMediaRouter({ getMedia, getBytes, secret, now = Date.now } = {}) {
  const fetchMedia = getMedia || require('../../database/trailerMedia').getTrailerMedia;
  const fetchBytes = getBytes || ((media, opts) => require('../../services/trailerStorage').getObject(media, opts));
  const signingSecret = secret === undefined ? require('../../config/config').jwtSecret : secret;
  const router = express.Router();

  router.get('/:id', async (req, res) => {
    const mediaId = Number(req.params.id);
    const verification = verifyTrailerMediaReference({
      mediaId,
      version: req.query.v,
      variant: req.query.p,
      expiresAt: req.query.exp,
      signature: req.query.sig,
      secret: signingSecret,
      now: now(),
    });
    if (!verification.ok) {
      const expired = verification.reason === 'expired';
      return res.status(expired ? 410 : 403).json({
        error: expired ? 'Media link expired.' : 'Invalid media link.',
        code: expired ? 'TRAILER_MEDIA_LINK_EXPIRED' : 'TRAILER_MEDIA_LINK_INVALID',
      });
    }

    try {
      const media = await fetchMedia(mediaId);
      if (!media) return res.status(404).json({ error: 'Media not found.', code: 'TRAILER_MEDIA_NOT_FOUND' });

      // Replacing a file must invalidate every link to the previous one.
      if (mediaVersion(media) !== req.query.v) {
        return res.status(404).json({
          error: 'This file has been replaced.',
          code: 'TRAILER_MEDIA_VERSION_REPLACED',
        });
      }

      // The variant comes from the VERIFIED signature, never straight off the
      // query string.
      const stored = await fetchBytes(media, { preview: verification.variant === 'preview' });
      if (!stored?.bytes?.length) {
        return res.status(404).json({ error: 'Media not found.', code: 'TRAILER_MEDIA_NOT_FOUND' });
      }

      const mimeType = INLINE_TYPES.has(media.mime_type) ? media.mime_type : 'application/octet-stream';
      res.set({
        'Content-Type': mimeType,
        'Content-Length': String(stored.bytes.length),
        'Cache-Control': 'private, no-store, max-age=0',
        'X-Content-Type-Options': 'nosniff',
      });
      return res.send(stored.bytes);
    } catch (error) {
      // Deliberately terse, and NEVER echoing the URL: the query string carries
      // a live signature.
      console.error('[TRAILER-MEDIA] delivery failed for media', mediaId, '-', error.message);
      return res.status(500).json({ error: 'Media delivery failed.' });
    }
  });

  return router;
}

module.exports = { createTrailerMediaRouter };
