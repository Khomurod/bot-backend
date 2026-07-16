/**
 * Public, signed screenshot download used only by Telegram's Bot API.
 *
 * Admin previews remain auth-gated under /api/route-control/:id/screenshot.
 * This endpoint needs no admin cookie because Telegram fetches it server-side;
 * access is limited by an HMAC signature, a short expiry, and image-version
 * binding. Query strings are deliberately never logged here.
 */
const express = require('express');
const {
  screenshotVersion,
  verifyTelegramScreenshotReference,
} = require('../../services/routeControl/screenshotMediaReference');

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function createRouteScreenshotMediaRouter({
  getScreenshot,
  secret,
  now = Date.now,
} = {}) {
  const fetchScreenshot = getScreenshot || require('../../database/routeControl').getRouteScreenshot;
  const signingSecret = secret === undefined ? require('../../config/config').jwtSecret : secret;
  const router = express.Router();

  router.get('/:id', async (req, res) => {
    const assignmentId = Number(req.params.id);
    const verification = verifyTelegramScreenshotReference({
      assignmentId,
      version: req.query.v,
      expiresAt: req.query.exp,
      signature: req.query.sig,
      secret: signingSecret,
      now: now(),
    });
    if (!verification.ok) {
      const expired = verification.reason === 'expired';
      return res.status(expired ? 410 : 403).json({
        error: expired ? 'Screenshot link expired.' : 'Invalid screenshot link.',
        code: expired ? 'SCREENSHOT_LINK_EXPIRED' : 'SCREENSHOT_LINK_INVALID',
      });
    }

    try {
      const screenshot = await fetchScreenshot(assignmentId);
      if (!screenshot?.file_data) {
        return res.status(404).json({ error: 'Screenshot not found.', code: 'SCREENSHOT_NOT_FOUND' });
      }
      if (screenshotVersion(screenshot) !== req.query.v) {
        return res.status(404).json({
          error: 'This screenshot has been replaced.',
          code: 'SCREENSHOT_VERSION_REPLACED',
        });
      }
      const mimeType = ALLOWED_IMAGE_TYPES.has(screenshot.mime_type)
        ? screenshot.mime_type
        : 'application/octet-stream';
      res.set({
        'Content-Type': mimeType,
        'Content-Length': String(screenshot.file_data.length),
        'Cache-Control': 'private, no-store, max-age=0',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'inline',
      });
      return res.status(200).send(screenshot.file_data);
    } catch (error) {
      console.error(
        `[ROUTE-SCREENSHOT-MEDIA] assignment=${Number.isSafeInteger(assignmentId) ? assignmentId : 'invalid'}`
        + ` fetch=failed code=${error.code || 'SCREENSHOT_MEDIA_FETCH_FAILED'}`
      );
      return res.status(500).json({
        error: 'Screenshot could not be loaded.',
        code: 'SCREENSHOT_MEDIA_FETCH_FAILED',
      });
    }
  });

  return router;
}

module.exports = { createRouteScreenshotMediaRouter };
