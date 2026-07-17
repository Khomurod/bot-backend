/**
 * Signed delivery of database-backed trailer media (/api/trailer-media/:id).
 *
 * The route is deliberately UNAUTHENTICATED — Telegram has no session — so the
 * signature IS the access control. These tests are the security surface:
 * nothing is served without a valid, unexpired, correctly-scoped signature, and
 * replacing a file invalidates every link to the old one.
 *
 * Mirrors tests for the Route Control screenshot route, which does the same job.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const crypto = require('node:crypto');

const { createTrailerMediaRouter } = require('../server/routes/trailerMediaRoutes');
const { buildTrailerMediaUrl } = require('../services/trailerStorage/mediaReference');

const SECRET = 'media-signing-secret';
const BASE_URL = 'https://trailer.test';
const BYTES = Buffer.from('the-photo-bytes');
const CHECKSUM = crypto.createHash('sha256').update(BYTES).digest('hex');

const MEDIA = {
  id: 7,
  storage_backend: 'database',
  blob_id: 42,
  mime_type: 'image/jpeg',
  checksum_sha256: CHECKSUM,
};

/** Start the router on an ephemeral port and return a fetch helper. */
async function startServer(overrides = {}) {
  const app = express();
  app.use('/api/trailer-media', createTrailerMediaRouter({
    getMedia: async (id) => (Number(id) === MEDIA.id ? MEDIA : null),
    getBytes: async () => ({ bytes: BYTES, mimeType: 'image/jpeg', filename: 'photo.jpg' }),
    secret: SECRET,
    ...overrides,
  }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  return {
    server,
    fetchPath: (pathAndQuery) => fetch(`http://127.0.0.1:${port}${pathAndQuery}`),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** A valid signed URL, reduced to its path+query. */
function signedPath(overrides = {}) {
  const url = buildTrailerMediaUrl({
    mediaId: MEDIA.id, media: MEDIA, baseUrl: BASE_URL, secret: SECRET, ...overrides,
  });
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

test('a validly signed link serves the bytes', async (t) => {
  const app = await startServer();
  t.after(() => app.close());

  const res = await app.fetchPath(signedPath());

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.equal(Buffer.from(await res.arrayBuffer()).toString('utf8'), 'the-photo-bytes');
});

test('served media is never cached', async (t) => {
  const app = await startServer();
  t.after(() => app.close());

  const res = await app.fetchPath(signedPath());

  assert.match(res.headers.get('cache-control'), /no-store/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('an unsigned request is refused', async (t) => {
  const app = await startServer();
  t.after(() => app.close());

  const res = await app.fetchPath(`/api/trailer-media/${MEDIA.id}`);

  assert.equal(res.status, 403, 'there is no unsigned public URL for stored media');
  assert.equal((await res.json()).code, 'TRAILER_MEDIA_LINK_INVALID');
});

test('a tampered signature is refused', async (t) => {
  const app = await startServer();
  t.after(() => app.close());

  const parsed = new URL(signedPath(), BASE_URL);
  parsed.searchParams.set('sig', 'a'.repeat(43));

  const res = await app.fetchPath(`${parsed.pathname}${parsed.search}`);

  assert.equal(res.status, 403);
});

test('a link signed with the wrong secret is refused', async (t) => {
  const app = await startServer();
  t.after(() => app.close());

  const res = await app.fetchPath(signedPath({ secret: 'not-the-secret' }));

  assert.equal(res.status, 403);
});

test('a link for one media id cannot fetch another', async (t) => {
  const app = await startServer();
  t.after(() => app.close());

  // Signature is bound to the id, so swapping the path invalidates it.
  const parsed = new URL(signedPath(), BASE_URL);
  const res = await app.fetchPath(`/api/trailer-media/8${parsed.search}`);

  assert.equal(res.status, 403);
});

test('an expired link reports 410, distinctly from a bad one', async (t) => {
  const app = await startServer();
  t.after(() => app.close());

  // Signed 20 minutes ago with a 10-minute TTL.
  const res = await app.fetchPath(signedPath({ now: Date.now() - 20 * 60 * 1000 }));

  assert.equal(res.status, 410, 'expiry is diagnosable without leaking anything about the signature');
  assert.equal((await res.json()).code, 'TRAILER_MEDIA_LINK_EXPIRED');
});

test('the TTL cap holds even for a link signed with the real secret', async (t) => {
  const app = await startServer();
  t.after(() => app.close());

  // buildTrailerMediaUrl clamps the TTL, so a far-future link cannot come from
  // it — this forges one by hand with the correct secret, i.e. the worst case
  // where the signing key has leaked. The expiry cap must still bound the
  // damage to minutes rather than years.
  const version = crypto.createHash('sha256').update(CHECKSUM).digest('base64url').slice(0, 24);
  const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365;
  const signature = crypto
    .createHmac('sha256', SECRET)
    .update(`trailer-media:v1|${MEDIA.id}|${version}|original|${expiresAt}`)
    .digest('base64url');

  const res = await app.fetchPath(
    `/api/trailer-media/${MEDIA.id}?v=${version}&p=original&exp=${expiresAt}&sig=${signature}`,
  );

  assert.equal(res.status, 403, 'a correctly-signed but long-lived link is still rejected');
});

test('a link to REPLACED media 404s instead of serving stale bytes', async (t) => {
  // The version is content-derived, so a replacement invalidates old links.
  const app = await startServer({
    getMedia: async () => ({ ...MEDIA, checksum_sha256: 'a-completely-different-checksum' }),
  });
  t.after(() => app.close());

  const res = await app.fetchPath(signedPath());

  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, 'TRAILER_MEDIA_VERSION_REPLACED');
});

test('a missing media row 404s', async (t) => {
  const app = await startServer({ getMedia: async () => null });
  t.after(() => app.close());

  const res = await app.fetchPath(signedPath());

  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, 'TRAILER_MEDIA_NOT_FOUND');
});

test('the signed variant decides what is served, not the query string', async (t) => {
  let askedForPreview = null;
  const app = await startServer({
    getMedia: async () => ({ ...MEDIA, preview_blob_id: 43 }),
    getBytes: async (_media, opts) => {
      askedForPreview = Boolean(opts?.preview);
      return { bytes: BYTES, mimeType: 'image/jpeg', filename: 'p.jpg' };
    },
  });
  t.after(() => app.close());

  await app.fetchPath(signedPath({ variant: 'preview' }));
  assert.equal(askedForPreview, true, 'a preview link serves the preview');

  // Flipping the variant on a preview-signed link must break the signature
  // rather than quietly upgrade the holder to the full-resolution original.
  const parsed = new URL(signedPath({ variant: 'preview' }), BASE_URL);
  parsed.searchParams.set('p', 'original');
  const res = await app.fetchPath(`${parsed.pathname}${parsed.search}`);
  assert.equal(res.status, 403, 'the variant is signed');
});

test('an unknown variant is refused rather than defaulted', async (t) => {
  const app = await startServer();
  t.after(() => app.close());

  const parsed = new URL(signedPath(), BASE_URL);
  parsed.searchParams.set('p', 'full-resolution-please');
  const res = await app.fetchPath(`${parsed.pathname}${parsed.search}`);

  assert.equal(res.status, 403);
});

test('an unexpected media type is not served inline', async (t) => {
  // Never let a stored file dictate a content type a browser might execute.
  const app = await startServer({ getMedia: async () => ({ ...MEDIA, mime_type: 'text/html' }) });
  t.after(() => app.close());

  const res = await app.fetchPath(signedPath());

  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
});
