/**
 * Public infrastructure surface: health checks (Render + cron pings), the site
 * root, favicon, the static /presentation page, Meta-compliance pages, and the
 * loopback-only DAT UI inspector.
 *
 * Routes use their full paths; the router is mounted at the app root so
 * matching behavior is identical to the previous inline definitions.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { validateMetaAppCredentials } = require('../../services/facebookGraphService');
const { inspectDatPageLayout } = require('../../services/datUiInspectorService');

function isLoopbackRequest(req) {
  const candidates = [
    req.ip,
    req.socket?.remoteAddress,
    req.connection?.remoteAddress,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  return candidates.some((value) => (
    value === '::1'
    || value === '127.0.0.1'
    || value === '::ffff:127.0.0.1'
  ));
}

function renderMetaCompliancePage(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #f3f0e8; color: #152033; }
    main { max-width: 720px; margin: 48px auto; padding: 32px; background: #fff; border-radius: 16px; box-shadow: 0 12px 40px rgba(21,32,51,.08); }
    h1 { margin-top: 0; }
    p, li { line-height: 1.6; }
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    ${bodyHtml}
  </main>
</body>
</html>`;
}

function createHealthRoutes({ db, config }) {
  const router = express.Router();
  const imagePageAssetPath = path.join(__dirname, '..', 'public', '123.png');

  // ─── Health Check (public, for Render + external cron / uptime pings) ───
  // Pings the DB so a healthy response genuinely means the app can serve
  // requests, not just that Node is alive. Exposed at /api/health and /health
  // (short path for cron jobs). HEAD returns the same status code without a body.
  let metaCredentialHealthCache = { checkedAt: 0, meta: null };
  const META_CREDENTIAL_HEALTH_TTL_MS = 5 * 60 * 1000;

  async function getMetaCredentialHealth() {
    if (!config.metaAppId || !config.metaAppSecret) {
      return { configured: false, valid: false };
    }
    const now = Date.now();
    if (
      metaCredentialHealthCache.meta
      && now - metaCredentialHealthCache.checkedAt < META_CREDENTIAL_HEALTH_TTL_MS
    ) {
      return metaCredentialHealthCache.meta;
    }
    const validation = await validateMetaAppCredentials();
    const meta = {
      configured: true,
      valid: validation.valid,
      appId: config.metaAppId,
      ...(validation.valid ? {} : { error: validation.error }),
    };
    metaCredentialHealthCache = { checkedAt: now, meta };
    return meta;
  }

  async function runHealthCheck() {
    let dbOk = false;
    try {
      dbOk = await db.ping();
    } catch (err) {
      console.error('[API] Health DB ping failed:', err.message);
    }
    const meta = await getMetaCredentialHealth();
    return {
      healthy: dbOk,
      status: dbOk ? 'ok' : 'degraded',
      uptime: process.uptime(),
      db: dbOk,
      meta,
      service: 'driver-feedback-bot',
    };
  }

  async function healthHandler(req, res) {
    const body = await runHealthCheck();
    res.setHeader('Cache-Control', 'no-store');
    res.status(body.healthy ? 200 : 503);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.json(body);
  }

  function siteRootHandler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).type('html').send(
      '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
      '<title>Wenze Bot Backend</title></head><body>' +
      '<h1>Wenze Bot Backend</h1>' +
      '<p>Telegram + Facebook leads integration for Wenze Transport.</p>' +
      '<ul>' +
      '<li><a href="/admin/">Admin panel</a></li>' +
      '<li><a href="/privacy-policy.html">Privacy policy</a></li>' +
      '<li><a href="/terms-of-use">Terms of use</a></li>' +
      '</ul></body></html>'
    );
  }

  router.get('/', siteRootHandler);
  router.head('/', siteRootHandler);
  router.get('/api/health', healthHandler);
  router.head('/api/health', healthHandler);
  router.get('/health', healthHandler);
  router.head('/health', healthHandler);

  function imagePageHandler(req, res) {
    if (!fs.existsSync(imagePageAssetPath)) {
      return res.status(404).type('text/plain').send('Image not found.');
    }

    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.status(200).type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>123</title>
  <style>
    html, body { width: 100%; height: 100%; margin: 0; }
    body { display: grid; place-items: center; overflow: hidden; background: #ffe500; }
    img { display: block; width: min(88vw, 560px); height: auto; max-height: 88vh; object-fit: contain; }
  </style>
</head>
<body>
  <img src="/123/image.png" alt="Yellow graphic">
</body>
</html>`);
  }

  router.get('/123', imagePageHandler);
  router.get('/123/', imagePageHandler);
  router.get('/123/image.png', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.sendFile(imagePageAssetPath);
  });

  router.post('/api/dat-ui/inspect', async (req, res) => {
    try {
      if (!isLoopbackRequest(req)) {
        return res.status(403).json({ error: 'DAT UI inspector is only available from localhost' });
      }

      const estimatedSize = Buffer.byteLength(JSON.stringify(req.body || {}), 'utf8');
      if (estimatedSize > 50_000) {
        return res.status(413).json({ error: 'Snapshot too large' });
      }

      const snapshot = req.body?.snapshot && typeof req.body.snapshot === 'object'
        ? {
            ...req.body.snapshot,
            url: req.body.snapshot.url || req.body?.url || '',
            signature: req.body.snapshot.signature || req.body?.signature || '',
            currentConfig: req.body.snapshot.currentConfig || req.body?.currentConfig || null,
          }
        : (req.body && typeof req.body === 'object' ? req.body : null);

      if (!snapshot) {
        return res.status(400).json({ error: 'snapshot object is required' });
      }

      const inspection = await inspectDatPageLayout(snapshot);
      return res.json({
        ok: true,
        ...inspection,
      });
    } catch (err) {
      console.error('[API] DAT UI inspect failed:', err.message);
      return res.status(500).json({
        ok: false,
        error: 'Failed to inspect DAT UI snapshot',
        detail: err.message,
      });
    }
  });

  // Avoid noisy browser console 404 for default favicon requests.
  router.get('/favicon.ico', (req, res) => {
    res.status(204).end();
  });

  // ─── Public product presentation (/presentation) ───
  // A self-contained, static marketing/overview page describing the whole
  // platform. It has no dependencies, exposes no data, and is fully isolated —
  // serving one file means direct browser access and refresh both work in
  // production regardless of the admin/fleet SPA builds.
  const presentationHtmlPath = path.join(__dirname, '..', 'presentation', 'index.html');
  function presentationHandler(req, res) {
    res.setHeader('Cache-Control', 'public, max-age=300');
    if (!fs.existsSync(presentationHtmlPath)) {
      return res.status(404).type('text/plain').send('Presentation page not found.');
    }
    return res.sendFile(presentationHtmlPath);
  }
  router.get('/presentation', presentationHandler);
  router.get('/presentation/', presentationHandler);

  router.get('/privacy-policy.html', (req, res) => {
    res.type('html').send(renderMetaCompliancePage(
      'Privacy Policy',
      '<p>This app connects Facebook Pages to Telegram groups for lead notifications. We only use Facebook data needed to authenticate Page managers, subscribe Pages to webhooks, and deliver lead events to the Telegram group you connect.</p><p>Contact: holmurod96@gmail.com</p>'
    ));
  });

  router.get('/terms-of-use', (req, res) => {
    res.type('html').send(renderMetaCompliancePage(
      'Terms of Use',
      '<p>By using this service you authorize the app to access the Facebook Pages you select and to send related lead notifications into your chosen Telegram group.</p>'
    ));
  });

  router.get('/user-data-deletion', (req, res) => {
    res.type('html').send(renderMetaCompliancePage(
      'User Data Deletion',
      '<p>To disconnect Facebook Page access, remove the Page connection in Telegram or revoke the app under your Facebook account settings. For help, email holmurod96@gmail.com.</p>'
    ));
  });

  return router;
}

module.exports = { createHealthRoutes };
