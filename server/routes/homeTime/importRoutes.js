/**
 * Home-Time screenshot IMPORT admin API.
 *
 * An admin uploads screenshots of an external tracker; AI vision reads the rows
 * and the apply step writes them. The parse and the apply are separate
 * endpoints on purpose — an admin reviews what was read before it is written.
 *
 * Images are shrunk by services/aiImagePrep.js before they leave for the model.
 *
 * Split out of server/routes/homeTimeRoutes.js.
 */

const express = require('express');
const multer = require('multer');
const homeTimeImport = require('../../../services/homeTimeImportService');

const SCREENSHOT_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
// Screenshots are held in memory (multer.memoryStorage) while AI vision reads
// them, so besides the per-file cap the whole batch is bounded: 12 × 8MB could
// otherwise stack 96MB in RAM on a 256MB-heap instance.
const MAX_SCREENSHOT_BATCH_BYTES = 40 * 1024 * 1024;
const screenshotUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 12 },
  fileFilter: (req, file, cb) => {
    if (SCREENSHOT_MIME_TYPES.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`Invalid file type: ${file.mimetype}. Allowed: jpg, png, webp`));
  },
});

function createHomeTimeImportRoutes({ authMiddleware }) {
  const router = express.Router();

  // POST /import-screenshots — AI vision reads uploaded screenshots and returns
  // matched driver rows for the admin to review (no writes yet).
  router.post('/import-screenshots', authMiddleware, (req, res) => {
    screenshotUpload.array('screenshots', 12)(req, res, async (uploadErr) => {
      if (uploadErr) {
        if (uploadErr instanceof multer.MulterError && uploadErr.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'A screenshot is too large (max 8MB each).' });
        }
        return res.status(400).json({ error: uploadErr.message });
      }
      if (!req.files || !req.files.length) {
        return res.status(400).json({ error: 'Upload at least one screenshot.' });
      }
      const totalBytes = req.files.reduce((sum, f) => sum + (f.size || 0), 0);
      if (totalBytes > MAX_SCREENSHOT_BATCH_BYTES) {
        return res.status(400).json({
          error: `Screenshot batch is too large (${(totalBytes / 1024 / 1024).toFixed(0)}MB > `
            + `${MAX_SCREENSHOT_BATCH_BYTES / 1024 / 1024}MB total). Upload fewer/smaller screenshots.`,
        });
      }
      try {
        const rows = await homeTimeImport.extractAndMatch(req.files);
        const matched = rows.filter((r) => r.matched).length;
        res.json({ rows, total: rows.length, matched, unmatched: rows.length - matched });
      } catch (err) {
        console.error('[HOME-TIME API] screenshot parse failed:', err.message);
        res.status(err.status || 500).json({ error: err.message || 'Failed to read screenshots.' });
      }
    });
  });

  // POST /import-screenshots/apply — write the reviewed rows (state + history).
  router.post('/import-screenshots/apply', authMiddleware, async (req, res) => {
    try {
      const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
      if (!rows) return res.status(400).json({ error: 'rows array is required' });
      const report = await homeTimeImport.applyRows(rows);
      res.json({ applied: true, ...report });
    } catch (err) {
      console.error('[HOME-TIME API] screenshot apply failed:', err.message);
      res.status(500).json({ error: 'Failed to apply imported rows.' });
    }
  });

  return router;
}

module.exports = {
  MAX_SCREENSHOT_BATCH_BYTES,
  SCREENSHOT_MIME_TYPES,
  createHomeTimeImportRoutes,
};
