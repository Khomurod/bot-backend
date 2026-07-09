/**
 * Leads-Bot proxy + Indeed lead intake.
 *
 * IMPORTANT: this router is mounted BEFORE the global express.json() so
 * (1) the raw body is preserved for Facebook's X-Hub-Signature-256
 * verification inside webhook_server.py, and (2) the Indeed route can accept
 * a base64 résumé PDF (up to ~12mb) with its own JSON parser.
 */
const express = require('express');
const http = require('http');
const { ingestIndeedLead } = require('../../services/indeedLeadService');

function createLeadsProxyRoutes({ internalSharedSecretGuard }) {
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

  // Indeed lead intake from the Gmail Apps Script. Auth is the same internal
  // shared secret used by the Facebook internal webhook.
  router.post(
    '/api/internal/indeed/lead',
    express.json({ limit: '12mb' }),
    internalSharedSecretGuard,
    async (req, res) => {
      try {
        const { messageId, from, subject, body, resumePdfBase64 } = req.body || {};
        if (!messageId) {
          return res.status(400).json({ error: 'messageId is required' });
        }
        const result = await ingestIndeedLead({ messageId, from, subject, body, resumePdfBase64 });
        return res.json({ status: 'accepted', ...result });
      } catch (err) {
        console.error('[API] Indeed lead ingest failed:', err.message);
        return res.status(500).json({ error: 'Failed to ingest Indeed lead', detail: err.message });
      }
    }
  );

  return router;
}

module.exports = { createLeadsProxyRoutes };
