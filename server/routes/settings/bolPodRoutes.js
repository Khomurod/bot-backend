/**
 * BOL / POD document forwarding — admin API.
 *
 * The feature is OFF by default and enabled here, along with its routing mode
 * (matched driver group vs a single review group). The delivery list and the
 * retry endpoint are the operator's view of the forwarding ledger
 * (`datatruck_document_deliveries`), which is what stops the same document
 * being forwarded twice.
 *
 * Split out of server/routes/settingsRoutes.js.
 */

const express = require('express');
const { DateTime } = require('luxon');
const bolPod = require('../../../database/bolPodForwardingSettings');
const docsDb = require('../../../database/datatruckDocuments');
const {
  validateGroup: validateBolPodGroup,
  sendTestMessage: sendBolPodTestMessage,
} = require('../../../services/bolPodGroupValidation');

function presentBolPodDelivery(row) {
  return {
    id: row.id,
    docType: String(row.doc_classification || row.file_type || '').toLowerCase(),
    fileType: row.file_type,
    loadReference: row.load_reference || row.order_id || null,
    driverName: row.driver_name || null,
    unitNumber: row.unit_number || null,
    uploadedAt: row.uploaded_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    rollupStatus: docsDb.rollupDeliveryStatus(row),
    driver: {
      status: row.status,
      telegramGroupId: row.telegram_group_id != null ? String(row.telegram_group_id) : null,
      messageId: row.telegram_message_id != null ? String(row.telegram_message_id) : null,
      attemptCount: row.attempt_count,
      error: row.last_error || null,
    },
    central: {
      status: row.central_status,
      telegramGroupId: row.central_telegram_group_id != null ? String(row.central_telegram_group_id) : null,
      messageId: row.central_telegram_message_id != null ? String(row.central_telegram_message_id) : null,
      attemptCount: row.central_attempt_count,
      error: row.central_last_error || null,
    },
  };
}

/** Assemble the BOL/POD status panel (settings + delivery aggregates + last scan). */
async function getBolPodForwardingStatus() {
  const settings = await bolPod.getBolPodSettingsForAdmin();
  const summary = await docsDb.getDeliveryStatusSummary();
  // Lazy-require the running service + API client so building the router never
  // pulls in the Telegram bot at load time (keeps route tests light).
  let sourceConfigured = false;
  let lastRun = null;
  try { sourceConfigured = require('../../../services/datatruckApiService').isConfigured(); } catch { sourceConfigured = false; }
  try { lastRun = require('../../../services/datatruckDocumentService').getLastRunSummary(); } catch { lastRun = null; }
  return {
    enabled: settings.enabled,
    deliveryMode: settings.deliveryMode,
    documentTypeMode: settings.documentTypeMode,
    uncertainDocumentPolicy: settings.uncertainDocumentPolicy,
    centralGroupConfigured: settings.centralGroupConfigured,
    centralGroupValidated: settings.centralGroupValidated,
    centralGroupTitle: settings.centralGroupTitle,
    centralGroupId: settings.centralGroupId,
    sourceConfigured,
    lastSuccessAt: summary.lastSuccessAt,
    lastFailureAt: summary.lastFailureAt,
    lastError: summary.lastError,
    pendingRetries: summary.pendingRetries,
    totalSent: summary.totalSent,
    totalFailed: summary.totalFailed,
    lastCheckedAt: lastRun?.ranAt || null,
    lastCheck: lastRun
      ? {
          configured: lastRun.configured ?? null,
          ordersScanned: lastRun.ordersScanned ?? null,
          documentsScanned: lastRun.documentsScanned ?? null,
        }
      : null,
  };
}

/**
 * Admin Settings API — manage live-location provider credentials.
 *   GET  /            → masked settings (never returns raw secrets)
 *   PUT  /            → update settings (secrets encrypted at rest)
 *   POST /test        → live connectivity check for one provider
 *
 * The "test" endpoint validates a provider's credentials against the live API.
 * It uses candidate keys from the request body when supplied (so the operator
 * can verify a key BEFORE saving it), otherwise the currently-stored keys.
 */

function createBolPodSettingsRouter({ authMiddleware, telegram = null }) {
  const router = express.Router();

  // ─── BOL / POD document forwarding ──────────────────────────────────────────
  // Admin-controlled routing of DataTruck BOL/POD documents to Telegram groups.
  // Telegram group ids are not secrets and are returned in plaintext; the bot
  // token is never exposed. `telegram` (the shared bot client) is injected so the
  // validate/test endpoints can reach the Telegram API server-side.

  router.get('/bol-pod', authMiddleware, async (req, res) => {
    try {
      const settings = await bolPod.getBolPodSettingsForAdmin();
      res.json({ settings });
    } catch (err) {
      console.error('[SETTINGS API] bol-pod load failed:', err.message);
      res.status(500).json({ error: 'Failed to load BOL/POD settings' });
    }
  });

  router.put('/bol-pod', authMiddleware, async (req, res) => {
    try {
      const settings = await bolPod.updateBolPodSettings(req.body || {}, {
        updatedBy: req.admin?.username || null,
      });
      res.json({ settings });
    } catch (err) {
      // Validation failures (bad enum, enable-without-validated-group, …) → 400.
      if (err.statusCode === 400) {
        return res.status(400).json({ error: err.message });
      }
      console.error('[SETTINGS API] bol-pod update failed:', err.message);
      res.status(500).json({ error: 'Failed to save BOL/POD settings' });
    }
  });

  // Validate the central group server-side; on success persist its title +
  // validated_at. Uses a candidate id from the body (verify before enabling).
  router.post('/bol-pod/validate-group', authMiddleware, async (req, res) => {
    try {
      if (!telegram) return res.json({ ok: false, message: 'Telegram client unavailable.' });
      const groupId = req.body?.groupId ?? req.body?.centralGroupId;
      const result = await validateBolPodGroup(telegram, groupId);
      if (result.ok) {
        await bolPod.setValidatedCentralGroup({
          centralGroupId: groupId,
          title: result.title,
          updatedBy: req.admin?.username || null,
        });
      }
      res.json(result);
    } catch (err) {
      console.error('[SETTINGS API] bol-pod validate-group failed:', err.message);
      res.json({ ok: false, message: 'Validation failed. Check the group id and try again.' });
    }
  });

  // Send a harmless test message to the given (or configured) central group.
  router.post('/bol-pod/test-message', authMiddleware, async (req, res) => {
    try {
      if (!telegram) return res.json({ ok: false, message: 'Telegram client unavailable.' });
      let groupId = req.body?.groupId ?? req.body?.centralGroupId;
      if (groupId === undefined || groupId === null || String(groupId).trim() === '') {
        const settings = await bolPod.getBolPodConfig();
        groupId = settings.centralGroupId;
      }
      const result = await sendBolPodTestMessage(telegram, groupId);
      if (result.ok) {
        await bolPod.markCentralGroupTested({ updatedBy: req.admin?.username || null });
      }
      res.json(result);
    } catch (err) {
      console.error('[SETTINGS API] bol-pod test-message failed:', err.message);
      res.json({ ok: false, message: 'Failed to send test message.' });
    }
  });

  router.get('/bol-pod/status', authMiddleware, async (req, res) => {
    try {
      res.json(await getBolPodForwardingStatus());
    } catch (err) {
      console.error('[SETTINGS API] bol-pod status failed:', err.message);
      res.status(500).json({ error: 'Failed to load BOL/POD status' });
    }
  });

  router.get('/bol-pod/deliveries', authMiddleware, async (req, res) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
      const rows = await docsDb.listRecentDeliveries(limit);
      res.json({ deliveries: rows.map(presentBolPodDelivery) });
    } catch (err) {
      console.error('[SETTINGS API] bol-pod deliveries failed:', err.message);
      res.status(500).json({ error: 'Failed to load BOL/POD deliveries' });
    }
  });

  // Manual retry: only failed destinations become eligible again; a destination
  // that already succeeded is never resent.
  router.post('/bol-pod/deliveries/:id/retry', authMiddleware, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid delivery id.' });
      }
      const row = await docsDb.resetFailedDestinationsForRetry(id);
      if (!row) {
        return res.status(404).json({ error: 'No failed destination to retry for this delivery.' });
      }
      res.json({ delivery: presentBolPodDelivery(row) });
    } catch (err) {
      console.error('[SETTINGS API] bol-pod retry failed:', err.message);
      res.status(500).json({ error: 'Failed to retry delivery' });
    }
  });

  return router;
}

module.exports = { createBolPodSettingsRouter };
