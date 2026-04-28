const express = require('express');
const multer = require('multer');
const config = require('../../config/config');
const db = require('../../database/db');
const { bot } = require('../../bot/bot');
const { parseRateConfirmationFile } = require('../services/dispatchParserService');

const router = express.Router();
const DISPATCH_UPLOAD_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
const MAX_FILE_SIZE_MB = 20;
const uploadStorage = multer.memoryStorage();
const uploadLimits = { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024 };

function createUploadMiddleware(allowedMimeTypes, allowedTypesLabel) {
  return multer({
    storage: uploadStorage,
    limits: uploadLimits,
    fileFilter: (req, file, cb) => {
      if (allowedMimeTypes.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error(`Invalid file type: ${file.mimetype}. Allowed: ${allowedTypesLabel}`));
      }
    },
  });
}

const dispatchUpload = createUploadMiddleware(DISPATCH_UPLOAD_MIME_TYPES, 'pdf, jpg, png, webp');
const dispatchDocumentUpload = multer({
  storage: uploadStorage,
  limits: uploadLimits,
});

router.post('/parse-rate-con', (req, res) => {
  dispatchUpload.single('file')(req, res, async (err) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: `File too large. Maximum size is ${MAX_FILE_SIZE_MB}MB.` });
      }
      return res.status(400).json({ error: err.message });
    }

    try {
      const parsed = await parseRateConfirmationFile(req.file);
      return res.json(parsed);
    } catch (parseErr) {
      const status = parseErr.status || 500;
      const detail = parseErr?.error?.message || parseErr.message;
      console.error('[API] Dispatch parse error:', detail, parseErr?.attemptErrors || []);
      return res.status(status).json({
        error: detail || 'Could not parse that rate confirmation right now. Please try again shortly.',
      });
    }
  });
});

router.get('/groups', async (req, res) => {
  try {
    const groups = await db.getAllDriverGroups();
    res.json({
      managementGroupId: config.managementGroupId,
      groups: groups.map((group) => ({
        id: group.id,
        group_name: group.group_name,
        telegram_group_id: group.telegram_group_id,
        driver_first_name: group.driver_first_name || '',
        driver_last_name: group.driver_last_name || '',
      })),
    });
  } catch (err) {
    console.error('[API] Error fetching dispatch groups:', err.message);
    res.status(500).json({ error: 'Failed to fetch dispatch groups' });
  }
});

router.post('/send-to-telegram', (req, res) => {
  dispatchDocumentUpload.single('document')(req, res, async (err) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: `File too large. Maximum size is ${MAX_FILE_SIZE_MB}MB.` });
      }
      return res.status(400).json({ error: err.message });
    }

    const chatId = String(req.body?.chatId || '').trim();
    const messageText = typeof req.body?.messageText === 'string' ? req.body.messageText.trim() : '';

    if (!chatId) {
      return res.status(400).json({ error: 'chatId is required' });
    }
    if (!messageText) {
      return res.status(400).json({ error: 'messageText is required' });
    }

    try {
      await bot.telegram.sendMessage(chatId, messageText);

      if (req.file) {
        const fileSource = { source: req.file.buffer, filename: req.file.originalname };
        if (req.file.mimetype.startsWith('image/')) {
          await bot.telegram.sendPhoto(chatId, fileSource);
        } else {
          await bot.telegram.sendDocument(chatId, fileSource);
        }
      }

      return res.json({ success: true, documentSent: Boolean(req.file) });
    } catch (sendErr) {
      const detail = sendErr.response?.description || sendErr.message;
      console.error('[API] Dispatch Telegram send error:', detail);
      return res.status(500).json({ error: 'Failed to send dispatch load to Telegram', detail });
    }
  });
});

module.exports = router;

