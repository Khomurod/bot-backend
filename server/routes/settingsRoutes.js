const express = require('express');
const {
  getEldSettingsForAdmin,
  updateEldSettings,
  getEldConfig,
  looksLikeDocsUrl,
  DEFAULT_DRIVEHOS_API_BASE,
} = require('../../database/eldSettings');
const { fetchAllVehicleStats } = require('../../services/samsaraLocationService');
const {
  fetchAllLatestVehicleStatuses,
  getLiveLocationForGroupTitleFromDriveHos,
} = require('../../services/driveHosEldService');
const { getLiveLocationForGroupTitle } = require('../../services/samsaraLocationService');
const rc = require('../../database/ringcentral');
const messageGroups = require('../../database/messageRoutingSettings');
const gmaps = require('../../database/gmapsSettings');
const googleMapsClient = require('../../services/googleMapsClient');
const multer = require('multer');
const safetyVideo = require('../../database/safetyEventVideoSettings');
const { getAudioDurationSeconds } = require('../../utils/audioDuration');
const {
  getAccessToken,
  getExtensionInfo,
  fetchAccountCallLog,
  fetchExtensionCallLog,
} = require('../../services/ringCentralCallService');
const { DateTime } = require('luxon');
const bolPod = require('../../database/bolPodForwardingSettings');
const docsDb = require('../../database/datatruckDocuments');
const {
  validateGroup: validateBolPodGroup,
  sendTestMessage: sendBolPodTestMessage,
} = require('../../services/bolPodGroupValidation');

/**
 * Present one delivery row for the admin history. Never exposes the document's
 * file link (a private, presigned URL) or internal errors verbatim beyond a
 * short message. BIGINT ids are returned as strings to avoid precision loss.
 */
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
  try { sourceConfigured = require('../../services/datatruckApiService').isConfigured(); } catch { sourceConfigured = false; }
  try { lastRun = require('../../services/datatruckDocumentService').getLastRunSummary(); } catch { lastRun = null; }
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
function createSettingsRouter({ authMiddleware, telegram = null }) {
  const router = express.Router();

  router.get('/eld', authMiddleware, async (req, res) => {
    try {
      const settings = await getEldSettingsForAdmin();
      res.json({ settings });
    } catch (err) {
      console.error('[SETTINGS API] load failed:', err.message);
      res.status(500).json({ error: 'Failed to load settings' });
    }
  });

  router.put('/eld', authMiddleware, async (req, res) => {
    try {
      const settings = await updateEldSettings(req.body || {});
      res.json({ settings });
    } catch (err) {
      console.error('[SETTINGS API] update failed:', err.message);
      res.status(500).json({ error: 'Failed to save settings' });
    }
  });

  router.post('/eld/test', authMiddleware, async (req, res) => {
    const provider = String(req.body?.provider || '').toLowerCase();
    const groupTitle = String(req.body?.groupTitle || '').trim();
    try {
      const cfg = await getEldConfig();

      if (provider === 'samsara') {
        const apiKey = String(req.body?.apiKey || '').trim() || cfg.samsaraApiKeys[0] || '';
        if (!apiKey) {
          return res.json({ connected: false, message: 'No Samsara API key set.' });
        }
        if (groupTitle) {
          const loc = await getLiveLocationForGroupTitle({ groupTitle, apiKey, apiBase: cfg.samsaraApiBase });
          return res.json({
            connected: true,
            message: `Found unit ${loc.unitNumber} at ${loc.address || `${loc.latitude}, ${loc.longitude}`}.`,
          });
        }
        const vehicles = await fetchAllVehicleStats({ apiKey, apiBase: cfg.samsaraApiBase });
        return res.json({ connected: true, message: `Connected. ${vehicles.length} vehicle(s) visible.` });
      }

      if (provider === 'factor' || provider === 'leader') {
        const label = provider === 'factor' ? 'Factor ELD' : 'Leader ELD';
        const companyKeyLabel = provider === 'factor' ? 'Factor Company Key' : 'Leader Company Key';
        const providerKey = String(req.body?.providerKey || '').trim() || cfg.driveHosProviderKey || '';
        const companyKey = String(req.body?.companyKey || '').trim()
          || (provider === 'factor' ? cfg.factorCompanyKey : cfg.leaderCompanyKey) || '';

        // The base URL comes from the body override (verify-before-save) or the
        // stored value. Reject a Swagger/docs URL up front — it will never work.
        const configuredBase = (String(req.body?.apiBase || '').trim() || cfg.driveHosApiBaseConfigured || '')
          .replace(/\/+$/, '');

        // Field-level validation with clear, specific messages.
        if (!providerKey) {
          return res.json({ connected: false, message: `Provider Key is required before testing ${label}.` });
        }
        if (!configuredBase) {
          return res.json({ connected: false, message: `API Base URL is required before testing ${label}.` });
        }
        if (looksLikeDocsUrl(configuredBase)) {
          return res.json({
            connected: false,
            message: 'This looks like a documentation URL, not the actual API base URL. '
              + `Set the API Base URL to the real API host (e.g. ${DEFAULT_DRIVEHOS_API_BASE}).`,
          });
        }
        if (!companyKey) {
          return res.json({ connected: false, message: `${companyKeyLabel} is required before testing ${label}.` });
        }

        const apiBase = configuredBase;
        if (groupTitle) {
          const loc = await getLiveLocationForGroupTitleFromDriveHos({
            groupTitle,
            providerKey,
            companyKey,
            apiBase,
            providerLabel: label,
          });
          return res.json({
            connected: true,
            message: `Found unit ${loc.unitNumber} at ${loc.address || `${loc.latitude}, ${loc.longitude}`}.`,
          });
        }
        const vehicles = await fetchAllLatestVehicleStatuses({ providerKey, companyKey, apiBase });
        return res.json({ connected: true, message: `Connected. ${vehicles.length} vehicle(s) visible.` });
      }

      return res.status(400).json({ error: 'Unknown provider. Use samsara, factor, or leader.' });
    } catch (err) {
      console.error(`[SETTINGS API] test ${provider} failed:`, err.message);
      return res.json({ connected: false, message: err.message });
    }
  });

  // ─── RingCentral settings (credentials + KPI targets/thresholds) ───

  router.get('/ringcentral', authMiddleware, async (req, res) => {
    try {
      const settings = await rc.getRcSettingsForAdmin();
      res.json({ settings });
    } catch (err) {
      console.error('[SETTINGS API] RC load failed:', err.message);
      res.status(500).json({ error: 'Failed to load RingCentral settings' });
    }
  });

  router.put('/ringcentral', authMiddleware, async (req, res) => {
    try {
      const settings = await rc.updateRcSettings(req.body || {});
      res.json({ settings });
    } catch (err) {
      console.error('[SETTINGS API] RC update failed:', err.message);
      res.status(500).json({ error: 'Failed to save RingCentral settings' });
    }
  });

  // Live auth + call-log read test. Uses candidate creds from the body when
  // supplied (verify before saving), otherwise the stored creds.
  router.post('/ringcentral/test', authMiddleware, async (req, res) => {
    try {
      const stored = await rc.getRcConfig();
      const cfg = {
        apiBase: (String(req.body?.apiBase || '').trim() || stored.apiBase).replace(/\/+$/, ''),
        clientId: String(req.body?.clientId || '').trim() || stored.clientId,
        clientSecret: String(req.body?.clientSecret || '').trim() || stored.clientSecret,
        jwtToken: String(req.body?.jwtToken || '').trim() || stored.jwtToken,
      };
      if (!cfg.clientId || !cfg.clientSecret || !cfg.jwtToken) {
        return res.json({ connected: false, message: 'RingCentral credentials are incomplete.' });
      }
      await getAccessToken(cfg);
      // Confirm call-log read scope by pulling the last 24h. Prefer the
      // company log; when the shared JWT isn't an admin (403) fall back to its
      // own extension log — the same strategy the background sync uses.
      const now = DateTime.now();
      const window = { dateFrom: now.minus({ hours: 24 }).toUTC().toISO(), dateTo: now.toUTC().toISO() };
      let scopeNote = 'company-wide call log';
      let records;
      try {
        records = await fetchAccountCallLog({ cfg, ...window });
      } catch (err) {
        if (err.status !== 403) throw err;
        records = await fetchExtensionCallLog({ cfg, ...window });
        const ext = await getExtensionInfo(cfg).catch(() => null);
        const owns = ext?.phoneNumbers?.length ? ` — this JWT covers ${ext.phoneNumbers.join(', ')}` : '';
        scopeNote = `this JWT's own extension only (not an admin)${owns}. Recruiters on other numbers need their own JWT`;
      }
      return res.json({
        connected: true,
        message: `Authenticated. Read ${records.length} call(s) from the last 24h via ${scopeNote}.`,
      });
    } catch (err) {
      console.error('[SETTINGS API] RC test failed:', err.message);
      return res.json({ connected: false, message: err.message });
    }
  });

  // ─── Message routing (Telegram group per bonus / review category) ───
  // Telegram group IDs are not secrets — returned in plaintext for hand-editing.

  router.get('/message-groups', authMiddleware, async (req, res) => {
    try {
      const settings = await messageGroups.getMessageGroupSettingsForAdmin();
      res.json({ settings });
    } catch (err) {
      console.error('[SETTINGS API] message-groups load failed:', err.message);
      res.status(500).json({ error: 'Failed to load message group settings' });
    }
  });

  router.put('/message-groups', authMiddleware, async (req, res) => {
    try {
      const settings = await messageGroups.updateMessageGroupSettings(req.body || {});
      res.json({ settings });
    } catch (err) {
      console.error('[SETTINGS API] message-groups update failed:', err.message);
      res.status(500).json({ error: 'Failed to save message group settings' });
    }
  });

  // ─── Google Maps Platform settings (Route Control) ───
  // The server API key is a secret: masked on GET, encrypted at rest, never
  // returned raw. Group IDs above are not secrets; the Google key is.

  router.get('/gmaps', authMiddleware, async (req, res) => {
    try {
      const settings = await gmaps.getGmapsSettingsForAdmin();
      res.json({ settings });
    } catch (err) {
      console.error('[SETTINGS API] gmaps load failed:', err.message);
      res.status(500).json({ error: 'Failed to load Google Maps settings' });
    }
  });

  router.put('/gmaps', authMiddleware, async (req, res) => {
    try {
      const settings = await gmaps.updateGmapsSettings(req.body || {});
      res.json({ settings });
    } catch (err) {
      console.error('[SETTINGS API] gmaps update failed:', err.message);
      res.status(500).json({ error: 'Failed to save Google Maps settings' });
    }
  });

  // Live "Test connection" — uses a candidate key from the body (verify before
  // saving) or the stored key. Never echoes the key back.
  router.post('/gmaps/test', authMiddleware, async (req, res) => {
    try {
      const apiKey = String(req.body?.apiKey || '').trim() || undefined;
      const result = await googleMapsClient.testConnection({ apiKey });
      res.json(result);
    } catch (err) {
      console.error('[SETTINGS API] gmaps test failed:', err.message);
      res.json({ connected: false, message: err.message });
    }
  });

  // ── Safety-event driver-group music overlay ────────────────────────────────
  //
  // Settings + uploaded music for the DRIVER-GROUP speeding-video music overlay.
  // The Samsara notifications group is never affected by any of this — it always
  // gets the original, immediate video (see samsara-integration).
  //
  // Music bytes are uploaded here (multipart) and stored as Postgres BYTEA so the
  // separate samsara-integration poller can read them. Uploads use their own
  // in-memory multer instance (the file never touches disk).
  const musicUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: safetyVideo.MAX_MUSIC_BYTES },
    fileFilter: (req, file, cb) => {
      if (safetyVideo.ALLOWED_AUDIO_MIME_TYPES.includes(String(file.mimetype).toLowerCase())) {
        cb(null, true);
      } else {
        cb(new Error(`Unsupported audio type: ${file.mimetype}`));
      }
    },
  });

  router.get('/safety-events', authMiddleware, async (req, res) => {
    try {
      const view = await safetyVideo.getSafetyEventVideoSettingsForAdmin();
      res.json(view);
    } catch (err) {
      console.error('[SETTINGS API] safety-events load failed:', err.message);
      res.status(500).json({ error: 'Failed to load safety-event music settings' });
    }
  });

  router.put('/safety-events', authMiddleware, async (req, res) => {
    try {
      const view = await safetyVideo.updateSafetyEventVideoSettings(req.body || {});
      res.json(view);
    } catch (err) {
      console.error('[SETTINGS API] safety-events update failed:', err.message);
      res.status(500).json({ error: 'Failed to save safety-event music settings' });
    }
  });

  // Upload a music clip. Multer errors (wrong type / too big) surface as 400.
  router.post('/safety-events/music', authMiddleware, (req, res) => {
    musicUpload.single('file')(req, res, async (uploadErr) => {
      if (uploadErr) {
        const tooBig = uploadErr.code === 'LIMIT_FILE_SIZE';
        return res.status(400).json({
          error: tooBig
            ? `File too large (max ${Math.round(safetyVideo.MAX_MUSIC_BYTES / (1024 * 1024))} MB)`
            : uploadErr.message,
        });
      }
      try {
        if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
          return res.status(400).json({ error: 'No audio file provided (field name "file")' });
        }
        const { originalname, mimetype, buffer } = req.file;
        const durationSeconds = getAudioDurationSeconds(buffer, mimetype);
        const name = String(req.body?.name || originalname || 'music').slice(0, 200);
        const description = req.body?.description ? String(req.body.description).slice(0, 1000) : null;
        // Default: newly uploaded music becomes active. Pass activate=false to
        // stage it inactive.
        const activate = String(req.body?.activate ?? 'true') !== 'false';
        await safetyVideo.insertMusicAsset({
          name,
          description,
          mimeType: mimetype,
          data: buffer,
          durationSeconds,
          uploadedBy: req.admin?.username || null,
          activate,
        });
        const view = await safetyVideo.getSafetyEventVideoSettingsForAdmin();
        res.status(201).json(view);
      } catch (err) {
        console.error('[SETTINGS API] safety-events music upload failed:', err.message);
        res.status(500).json({ error: 'Failed to store music asset' });
      }
    });
  });

  router.post('/safety-events/music/:id/activate', authMiddleware, async (req, res) => {
    try {
      const asset = await safetyVideo.setActiveMusicAsset(Number(req.params.id));
      if (!asset) return res.status(404).json({ error: 'Music asset not found' });
      res.json(await safetyVideo.getSafetyEventVideoSettingsForAdmin());
    } catch (err) {
      console.error('[SETTINGS API] safety-events activate failed:', err.message);
      res.status(500).json({ error: 'Failed to activate music asset' });
    }
  });

  router.post('/safety-events/music/:id/deactivate', authMiddleware, async (req, res) => {
    try {
      await safetyVideo.deactivateMusicAsset(Number(req.params.id));
      res.json(await safetyVideo.getSafetyEventVideoSettingsForAdmin());
    } catch (err) {
      console.error('[SETTINGS API] safety-events deactivate failed:', err.message);
      res.status(500).json({ error: 'Failed to deactivate music asset' });
    }
  });

  router.delete('/safety-events/music/:id', authMiddleware, async (req, res) => {
    try {
      const result = await safetyVideo.deleteMusicAsset(Number(req.params.id));
      if (!result.deleted && result.reason === 'is_active') {
        return res.status(409).json({ error: 'Deactivate the asset before deleting it' });
      }
      if (!result.deleted && result.reason === 'not_found') {
        return res.status(404).json({ error: 'Music asset not found' });
      }
      res.json(await safetyVideo.getSafetyEventVideoSettingsForAdmin());
    } catch (err) {
      console.error('[SETTINGS API] safety-events delete failed:', err.message);
      res.status(500).json({ error: 'Failed to delete music asset' });
    }
  });

  // Authenticated preview/download of the raw music bytes (admin only — the file
  // is never exposed publicly). Streams from Postgres BYTEA.
  router.get('/safety-events/music/:id/download', authMiddleware, async (req, res) => {
    try {
      const asset = await safetyVideo.getMusicAssetById(Number(req.params.id), { includeData: true });
      if (!asset || !asset.data) return res.status(404).json({ error: 'Music asset not found' });
      res.setHeader('Content-Type', asset.mimeType || 'application/octet-stream');
      res.setHeader('Content-Length', asset.data.length);
      res.setHeader('Content-Disposition', `inline; filename="music-${asset.id}"`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(asset.data);
    } catch (err) {
      console.error('[SETTINGS API] safety-events download failed:', err.message);
      res.status(500).json({ error: 'Failed to load music asset' });
    }
  });

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

module.exports = { createSettingsRouter };
