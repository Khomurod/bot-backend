/**
 * Safety-event driver-group music overlay — admin API.
 *
 * Uploaded tracks are overlaid on dashcam clips by the SEPARATE Samsara
 * service, which reads these rows from the shared database. This app only
 * manages them; nothing here sends a safety alert.
 *
 * Exactly one track may be active at a time, which is why activate/deactivate
 * are their own endpoints rather than a PUT of a flag.
 *
 * Split out of server/routes/settingsRoutes.js.
 */

const express = require('express');
const multer = require('multer');
const safetyVideo = require('../../../database/safetyEventVideoSettings');
const { getAudioDurationSeconds } = require('../../../utils/audioDuration');

function createSafetyEventSettingsRouter({ authMiddleware, telegram = null }) {
  const router = express.Router();

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

  return router;
}

module.exports = { createSafetyEventSettingsRouter };
