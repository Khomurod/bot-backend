const express = require('express');
const multer = require('multer');
const config = require('../../config/config');
const db = require('../../database/db');
const { bot } = require('../../bot/bot');
const { parseRateConfirmationFile } = require('../services/dispatchParserService');
const { triggerDispatchEtaNowByGroupId } = require('../../services/dispatchEtaUpdateService');

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

function toBoolean(value, defaultValue = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return defaultValue;
}

function parseIntervalMinutes(body, fallback = 60) {
  if (Number.isInteger(body?.intervalMinutes)) {
    return body.intervalMinutes;
  }

  const parsedInterval = Number.parseInt(body?.intervalMinutes, 10);
  if (Number.isInteger(parsedInterval) && !Number.isNaN(parsedInterval)) {
    return parsedInterval;
  }

  const parsedHours = Number.parseInt(body?.hours, 10);
  const parsedMinutes = Number.parseInt(body?.minutes, 10);
  if (Number.isInteger(parsedHours) || Number.isInteger(parsedMinutes)) {
    const safeHours = Number.isInteger(parsedHours) && parsedHours > 0 ? parsedHours : 0;
    const safeMinutes = Number.isInteger(parsedMinutes) && parsedMinutes > 0 ? parsedMinutes : 0;
    return safeHours * 60 + safeMinutes;
  }

  return fallback;
}

function mapEtaRow(row) {
  const interval = Number(row?.eta_interval_minutes ?? row?.interval_minutes ?? 60) || 60;
  return {
    group_id: row.group_id ?? row.id,
    group_name: row.group_name,
    telegram_group_id: row.telegram_group_id,
    eta_enabled: Boolean(row.eta_enabled ?? row.enabled),
    eta_interval_minutes: interval,
    eta_interval_hours: Math.floor(interval / 60),
    eta_interval_remaining_minutes: interval % 60,
    eta_next_run_at: row.eta_next_run_at ?? row.next_run_at ?? null,
    eta_last_run_at: row.eta_last_run_at ?? row.last_run_at ?? null,
    eta_last_status: row.eta_last_status ?? row.last_status ?? null,
    eta_last_error: row.eta_last_error ?? row.last_error ?? null,
  };
}

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

router.get('/testing-feature/groups', async (req, res) => {
  try {
    const rows = await db.getDriverGroupsWithDispatchEtaSettings();
    return res.json({
      groups: rows.map(mapEtaRow),
    });
  } catch (err) {
    console.error('[API] Dispatch ETA groups fetch failed:', err.message);
    return res.status(500).json({ error: 'Failed to fetch testing feature groups' });
  }
});

router.put('/testing-feature/groups/:groupId', async (req, res) => {
  const groupId = Number.parseInt(req.params.groupId, 10);
  if (!Number.isInteger(groupId) || groupId <= 0) {
    return res.status(400).json({ error: 'Invalid groupId' });
  }

  try {
    const targetGroups = await db.getGroupsByIds([groupId]);
    if (!targetGroups.length) {
      return res.status(404).json({ error: 'Active driver group not found' });
    }

    const existing = await db.getDispatchEtaSettingByGroupId(groupId);
    const enabled = toBoolean(req.body?.enabled, Boolean(existing?.enabled));
    const intervalMinutes = parseIntervalMinutes(req.body, existing?.interval_minutes || 60);

    if (enabled && (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440)) {
      return res.status(400).json({ error: 'Interval must be between 1 and 1440 minutes' });
    }

    const saved = await db.upsertDispatchEtaSetting({
      groupId,
      enabled,
      intervalMinutes: Number.isInteger(intervalMinutes) ? intervalMinutes : (existing?.interval_minutes || 60),
      nextRunAt: enabled ? new Date().toISOString() : null,
    });

    let immediate = null;
    if (enabled) {
      immediate = await triggerDispatchEtaNowByGroupId(groupId);
    }

    const refreshed = await db.getDispatchEtaSettingByGroupId(groupId);
    const groupRow = targetGroups[0];
    const responseRow = mapEtaRow({
      group_id: groupRow.id,
      ...groupRow,
      ...refreshed,
    });

    return res.json({
      success: true,
      setting: responseRow,
      immediate,
    });
  } catch (err) {
    console.error('[API] Dispatch ETA update failed:', err.message);
    return res.status(500).json({ error: 'Failed to update testing feature setting', detail: err.message });
  }
});

module.exports = router;
