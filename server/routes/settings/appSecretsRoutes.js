'use strict';

/**
 * Settings → System → Secrets — the deployment's settings, stored encrypted in
 * the app instead of in Coolify (docs/architecture/app-secrets.md).
 *
 *   GET    /app-secrets                       names, scopes, last four characters, versions
 *   POST   /app-secrets/preview               what an uploaded .env would change (no save)
 *   PUT    /app-secrets                       save it as a new version, then restart
 *   DELETE /app-secrets/:scope/:name          a new version without that value, then restart
 *   POST   /app-secrets/versions/:id/restore  a new version equal to an older one, then restart
 *
 * SUPER ADMINISTRATORS ONLY, by role. A value travels only in a request body
 * (the uploaded file), is never in a response and never in a log line.
 *
 * A save that touches what THIS app reads ends with the app restarting itself:
 * the answer goes out first, then SIGTERM runs the normal graceful shutdown
 * (index.js) and Docker starts the container again (restart: unless-stopped).
 * A save that touches only the Samsara service's values does not restart this
 * app — that service notices the new version itself.
 */
const express = require('express');
const service = require('../../../services/appSecrets/secretsService');
const { requireSuperAdmin } = require('../../middleware/auth');
const { createRateLimiter } = require('../../middleware/rateLimit');
const { insertAdminAudit: defaultInsertAdminAudit } = require('../../../database/adminAudit');

const PREVIEW_WINDOW_MS = 5 * 60 * 1000;
const PREVIEW_MAX_PER_WINDOW = 20;
const RESTART_DELAY_MS = 1500;

function defaultRestart(delayMs = RESTART_DELAY_MS) {
  setTimeout(() => {
    console.log('[Secrets] Restarting to load the saved secrets.');
    process.kill(process.pid, 'SIGTERM');
  }, delayMs).unref();
}

function failed(res, err, what) {
  if (err.statusCode === 400 || err.statusCode === 409) {
    return res.status(err.statusCode).json({ error: err.message, ...(err.preview ? { preview: err.preview } : {}) });
  }
  // A database or crypto error message holds no value of ours, but keep only its class.
  console.error(`[SETTINGS API] secrets ${what} failed:`, err && err.code ? err.code : 'error');
  return res.status(500).json({ error: `Failed to ${what} the secrets` });
}

function createAppSecretsRouter({
  authMiddleware,
  secretsService = service,
  insertAdminAudit = defaultInsertAdminAudit,
  restart = defaultRestart,
  previewLimiter = null,
}) {
  const router = express.Router();
  const guard = [authMiddleware, requireSuperAdmin];
  const limitPreviews = previewLimiter || createRateLimiter({
    windowMs: PREVIEW_WINDOW_MS,
    max: PREVIEW_MAX_PER_WINDOW,
    message: 'Too many previews in a few minutes — each one asks Telegram about the bot tokens. Wait a little.',
  });

  const audit = (req, action, newValues) => insertAdminAudit({
    adminId: req.admin?.id ?? null,
    roleKeys: req.admin?.role_keys || [],
    action,
    entityType: 'app_secrets',
    entityId: newValues.versionId == null ? null : String(newValues.versionId),
    oldValues: null,
    newValues,
    ipAddress: req.ip || null,
  }).catch((err) => console.warn('[SETTINGS API] Could not audit a secrets change:', err.message));

  const who = (req) => (req.admin && req.admin.username) || null;

  router.get('/app-secrets', ...guard, async (req, res) => {
    try {
      return res.json(await secretsService.getView());
    } catch (err) {
      return failed(res, err, 'load');
    }
  });

  router.post('/app-secrets/preview', ...guard, limitPreviews, async (req, res) => {
    try {
      // The service already leaves out its internal plan (which holds values);
      // dropped here again so no service change can ever send it.
      const { _plan, ...preview } = await secretsService.preview({ target: req.body?.target, text: req.body?.text });
      return res.json({ preview });
    } catch (err) {
      return failed(res, err, 'preview');
    }
  });

  router.put('/app-secrets', ...guard, limitPreviews, async (req, res) => {
    try {
      const out = await secretsService.save({
        target: req.body?.target, text: req.body?.text, baseVersion: req.body?.baseVersion ?? null, by: who(req),
      });
      const p = out.preview;
      // Names only: what changed, never a value.
      await audit(req, 'app_secrets.save', {
        versionId: out.versionId,
        target: p.target,
        added: p.added.map((c) => `${c.scope}:${c.name}`),
        changed: p.changed.map((c) => `${c.scope}:${c.name}`),
        removed: p.removed.map((c) => `${c.scope}:${c.name}`),
      });
      if (p.restartsThisApp) restart();
      return res.json({ versionId: out.versionId, restarting: p.restartsThisApp, preview: p });
    } catch (err) {
      return failed(res, err, 'save');
    }
  });

  router.delete('/app-secrets/:scope/:name', ...guard, async (req, res) => {
    try {
      const out = await secretsService.removeValue({ scope: req.params.scope, name: req.params.name, by: who(req) });
      await audit(req, 'app_secrets.remove', { versionId: out.versionId, removed: [`${req.params.scope}:${req.params.name}`] });
      if (out.restartsThisApp) restart();
      return res.json({ versionId: out.versionId, restarting: out.restartsThisApp });
    } catch (err) {
      return failed(res, err, 'remove');
    }
  });

  router.post('/app-secrets/versions/:id/restore', ...guard, async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Unknown version' });
    try {
      const out = await secretsService.restore({ versionId: id, by: who(req) });
      await audit(req, 'app_secrets.restore', { versionId: out.versionId, restoredFrom: out.restoredFrom });
      restart();
      return res.json({ ...out, restarting: true });
    } catch (err) {
      return failed(res, err, 'restore');
    }
  });

  return router;
}

module.exports = { createAppSecretsRouter, PREVIEW_MAX_PER_WINDOW };
