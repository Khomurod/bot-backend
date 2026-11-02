/**
 * Leads-Bot proxy.
 *
 * IMPORTANT: this router is mounted BEFORE the global express.json() so the
 * raw body is preserved for Facebook's X-Hub-Signature-256 verification inside
 * webhook_server.py.
 *
 * The Indeed intake that also lived here (`POST /api/internal/indeed/lead`, fed
 * by a Gmail Apps Script) was removed in November 2026 at the owner's decision;
 * see docs/ARCHIVED_FEATURES.md.
 */
const express = require('express');
const http = require('http');

function createLeadsProxyRoutes() {
  const router = express.Router();

  const LEADS_BOT_PORT = process.env.LEADS_BOT_PORT || 8000;

  function proxyToLeadsBot(req, res) {
    const options = {
      hostname: 'localhost',
      port: LEADS_BOT_PORT,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `localhost:${LEADS_BOT_PORT}` },
    };

    const proxyReq = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      console.error('[PROXY] Leads-Bot proxy error:', err.message);
      if (!res.headersSent) {
        res.status(502).json({ error: 'Leads-Bot unavailable', detail: err.message });
      }
    });

    req.pipe(proxyReq);
  }

  router.all('/webhook', proxyToLeadsBot);
  router.all('/rc-webhook', proxyToLeadsBot);

  return router;
}

module.exports = { createLeadsProxyRoutes };
