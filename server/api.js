const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const multer = require('multer');
const config = require('../config/config');
const db = require('../database/db');
const { bot, sendQuestionToGroups, sendTestQuestion, sendBroadcast, sendBroadcastTest, sendBroadcastToGroups, sendConfirmationBroadcast, sendConfirmationBroadcastTest } = require('../bot/bot');
const { translateBatch } = require('../services/translationService');
const { DateTime } = require('luxon');
const employeeVotingRoutes = require('./employeeVotingApi');

// ─── Multer: memory storage for media uploads ───
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime'];
const MAX_FILE_SIZE_MB = 20;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type: ${file.mimetype}. Allowed: jpg, png, webp, mp4, mov`));
    }
  },
});

const app = express();
app.use(cors());

// ─── Leads-Bot Proxy (Python/FastAPI on internal port) ───
// These routes MUST be before express.json() so the raw body is preserved
// for Facebook's X-Hub-Signature-256 verification in webhook_server.py.
const http = require('http');
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

app.all('/webhook', proxyToLeadsBot);
app.all('/rc-webhook', proxyToLeadsBot);
app.get('/leads-log', proxyToLeadsBot);
app.get('/retry/:id', (req, res) => {
  req.url = `/retry/${req.params.id}`;
  proxyToLeadsBot(req, res);
});

app.use(express.json({ limit: '1mb' }));

// Serve admin panel static files (production build)
app.use('/admin', express.static(path.join(__dirname, '..', 'admin', 'build')));

// ─── Employee Voting Routes (isolated) ───
app.use(employeeVotingRoutes);

// ─── Auth Middleware ───
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, config.jwtSecret);
    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ─── Auth Routes ───

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const admin = await db.getAdminByUsername(username);
    if (!admin) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: admin.id, username: admin.username },
      config.jwtSecret,
      { expiresIn: '24h' }
    );

    res.json({ token, username: admin.username });
  } catch (err) {
    console.error('[API] Login error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/auth/verify
app.get('/api/auth/verify', authMiddleware, (req, res) => {
  res.json({ valid: true, username: req.admin.username });
});

// ─── Health Check (public, for cron keep-alive) ───
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ─── Media Upload ───

// POST /api/upload-media
app.post('/api/upload-media', authMiddleware, (req, res) => {
  upload.single('media')(req, res, async (err) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: `File too large. Maximum size is ${MAX_FILE_SIZE_MB}MB.` });
      }
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    try {
      const isVideo = req.file.mimetype.startsWith('video/');
      const mediaType = isVideo ? 'video' : 'photo';
      const fileSource = { source: req.file.buffer, filename: req.file.originalname };
      const managementGroupId = config.managementGroupId;

      let sentMessage;
      if (isVideo) {
        sentMessage = await bot.telegram.sendVideo(managementGroupId, fileSource, {
          caption: '📎 [Upload to get file_id — will be deleted]',
        });
      } else {
        sentMessage = await bot.telegram.sendPhoto(managementGroupId, fileSource, {
          caption: '📎 [Upload to get file_id — will be deleted]',
        });
      }

      // Extract file_id
      let fileId;
      if (isVideo) {
        fileId = sentMessage.video?.file_id;
      } else {
        const photos = sentMessage.photo;
        // Use highest resolution
        fileId = photos && photos.length > 0 ? photos[photos.length - 1].file_id : null;
      }

      // Delete the temp message from management group
      try {
        await bot.telegram.deleteMessage(managementGroupId, sentMessage.message_id);
      } catch (_) {
        // Non-critical: ignore if delete fails
      }

      if (!fileId) {
        return res.status(500).json({ error: 'Failed to retrieve file_id from Telegram' });
      }

      console.log(`[API] Media uploaded: type=${mediaType}, file_id=${fileId}`);
      res.json({ file_id: fileId, media_type: mediaType });
    } catch (uploadErr) {
      console.error('[API] Media upload error:', uploadErr.message);
      res.status(500).json({ error: 'Failed to upload media to Telegram. Check bot permissions.' });
    }
  });
});

// ─── Groups Routes ───

// GET /api/groups
app.get('/api/groups', authMiddleware, async (req, res) => {
  try {
    const groups = await db.getAllGroups();
    res.json(groups);
  } catch (err) {
    console.error('[API] Error fetching groups:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/groups/:id/language
app.put('/api/groups/:id/language', authMiddleware, async (req, res) => {
  try {
    const { language } = req.body;
    if (!['en', 'ru', 'uz'].includes(language)) {
      return res.status(400).json({ error: 'Invalid language. Must be en, ru, or uz.' });
    }
    const group = await db.setGroupLanguage(req.params.id, language);
    if (!group) {
      return res.status(404).json({ error: 'Group not found' });
    }
    res.json(group);
  } catch (err) {
    console.error('[API] Error updating group language:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Questions Routes ───

// GET /api/questions
app.get('/api/questions', authMiddleware, async (req, res) => {
  try {
    const questions = await db.getAllQuestions();
    res.json(questions);
  } catch (err) {
    console.error('[API] Error fetching questions:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/questions/:id
app.get('/api/questions/:id', authMiddleware, async (req, res) => {
  try {
    const question = await db.getQuestionWithOptions(req.params.id);
    if (!question) {
      return res.status(404).json({ error: 'Question not found' });
    }
    res.json(question);
  } catch (err) {
    console.error('[API] Error fetching question:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/questions
app.post('/api/questions', authMiddleware, async (req, res) => {
  try {
    const { translations, options } = req.body;

    // Validate translations
    if (!translations || !Array.isArray(translations) || translations.length === 0) {
      return res.status(400).json({ error: 'Translations are required' });
    }

    // Ensure all 3 languages are present
    const langs = translations.map((t) => t.language);
    if (!langs.includes('en') || !langs.includes('ru') || !langs.includes('uz')) {
      return res.status(400).json({ error: 'Translations for en, ru, and uz are required' });
    }

    // Validate options
    if (!options || !Array.isArray(options) || options.length === 0) {
      return res.status(400).json({ error: 'At least one option is required' });
    }

    for (const opt of options) {
      if (!opt.translations || opt.translations.length < 3) {
        return res.status(400).json({ error: 'Each option must have translations for en, ru, and uz' });
      }
    }

    // Optional media items — validate if provided
    let mediaItems = null;
    if (Array.isArray(req.body.media_items) && req.body.media_items.length > 0) {
      if (req.body.media_items.length > 10) {
        return res.status(400).json({ error: 'Maximum 10 media items allowed per message' });
      }
      for (const item of req.body.media_items) {
        if (!item.file_id) return res.status(400).json({ error: 'Each media item must have a file_id' });
        if (!['photo', 'video'].includes(item.media_type)) {
          return res.status(400).json({ error: 'Each media item must have media_type of photo or video' });
        }
      }
      mediaItems = req.body.media_items;
    }

    const mediaPosition = req.body.media_position;
    if (mediaPosition && !['above', 'below'].includes(mediaPosition)) {
      return res.status(400).json({ error: 'media_position must be above or below' });
    }

    const question = await db.createQuestion(translations, options, mediaItems, mediaPosition || 'above');
    const full = await db.getQuestionWithOptions(question.id);
    res.status(201).json(full);
  } catch (err) {
    console.error('[API] Error creating question:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/questions/:id/deactivate
app.put('/api/questions/:id/deactivate', authMiddleware, async (req, res) => {
  try {
    await db.deactivateQuestion(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('[API] Error deactivating question:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/questions/:id/send
app.post('/api/questions/:id/send', authMiddleware, async (req, res) => {
  try {
    const questionId = parseInt(req.params.id, 10);
    const results = await sendQuestionToGroups(questionId);
    res.json(results);
  } catch (err) {
    console.error('[API] Error sending question:', err.message);
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

// POST /api/questions/send-test
app.post('/api/questions/send-test', authMiddleware, async (req, res) => {
  try {
    const { question_en, options_en } = req.body;

    if (!question_en || !question_en.trim()) {
      return res.status(400).json({ error: 'English question text is required' });
    }

    if (!options_en || !Array.isArray(options_en) || options_en.length < 2) {
      return res.status(400).json({ error: 'At least 2 English options are required' });
    }

    const emptyOpt = options_en.find((o) => !o || !o.trim());
    if (emptyOpt !== undefined) {
      return res.status(400).json({ error: 'All options must have non-empty English text' });
    }

    let mediaItems = null;
    const mediaPosition = req.body.media_position || 'above';
    if (Array.isArray(req.body.media_items) && req.body.media_items.length > 0) {
      mediaItems = req.body.media_items;
    }

    await sendTestQuestion(question_en.trim(), options_en.map((o) => o.trim()), mediaItems, mediaPosition);
    res.json({ success: true });
  } catch (err) {
    console.error('[API] Error sending test question:', err.message);
    res.status(500).json({ error: err.message || 'Failed to send test question' });
  }
});

// ─── Translation Routes ───

// POST /api/translate
app.post('/api/translate', authMiddleware, async (req, res) => {
  try {
    const { source_language, target_languages, text_blocks } = req.body;

    // Validate input
    if (!text_blocks || !Array.isArray(text_blocks) || text_blocks.length === 0) {
      return res.status(400).json({ error: 'text_blocks array is required' });
    }

    if (text_blocks.length > 20) {
      return res.status(400).json({ error: 'Maximum 20 text blocks allowed per request' });
    }

    const totalLength = text_blocks.reduce((sum, t) => sum + (t?.length || 0), 0);
    if (totalLength > 4096) {
      return res.status(400).json({ error: 'Total text exceeds 4096 character limit' });
    }

    const targets = target_languages || ['ru', 'uz'];
    const validLangs = ['ru', 'uz'];
    for (const lang of targets) {
      if (!validLangs.includes(lang)) {
        return res.status(400).json({ error: `Invalid target language: ${lang}` });
      }
    }

    const result = {};
    for (const lang of targets) {
      result[lang] = await translateBatch(text_blocks, lang);
    }

    res.json(result);
  } catch (err) {
    console.error('[API] Translation error:', err.message);
    res.status(500).json({ error: 'Translation failed. Please try again.' });
  }
});

// ─── Broadcast Routes ───

// POST /api/broadcast/send
app.post('/api/broadcast/send', authMiddleware, async (req, res) => {
  try {
    const { message_text, parse_mode, messages, group_ids } = req.body;

    const primaryText = (messages && messages.en) || message_text;
    if (!primaryText || !primaryText.trim()) {
      return res.status(400).json({ error: 'Message text is required' });
    }
    if (primaryText.length > 4096) {
      return res.status(400).json({ error: 'Message exceeds 4096 character limit' });
    }

    const mode = ['HTML', 'MarkdownV2'].includes(parse_mode) ? parse_mode : 'HTML';

    let mediaItems = null;
    const mediaPosition = req.body.media_position || 'above';
    if (Array.isArray(req.body.media_items) && req.body.media_items.length > 0) {
      if (req.body.media_items.length > 10) {
        return res.status(400).json({ error: 'Maximum 10 media items allowed' });
      }
      mediaItems = req.body.media_items;
    }

    // Create a broadcast record first, then pass the broadcastId to sendBroadcast
    const broadcast = await db.createBroadcast({
      type: 'regular',
      message_text_en: messages ? messages.en : primaryText.trim(),
      message_text_ru: messages ? messages.ru : null,
      message_text_uz: messages ? messages.uz : null,
      media_items: mediaItems,
      media_position: mediaPosition,
      parse_mode: mode,
    });

    // If specific group_ids provided, send only to those groups; otherwise send to all
    let results;
    if (Array.isArray(group_ids) && group_ids.length > 0) {
      const targetGroups = await db.getGroupsByIds(group_ids);
      results = await sendBroadcastToGroups(targetGroups, primaryText.trim(), mode, messages || null, mediaItems, mediaPosition, broadcast.id);
    } else {
      results = await sendBroadcast(primaryText.trim(), mode, messages || null, mediaItems, mediaPosition, broadcast.id);
    }
    res.json({ ...results, broadcast_id: broadcast.id });
  } catch (err) {
    console.error('[API] Error sending broadcast:', err.message);
    res.status(500).json({ error: err.message || 'Failed to send broadcast' });
  }
});

// POST /api/broadcast/test
app.post('/api/broadcast/test', authMiddleware, async (req, res) => {
  try {
    const { message_text, parse_mode, messages } = req.body;

    const primaryText = (messages && messages.en) || message_text;
    if (!primaryText || !primaryText.trim()) {
      return res.status(400).json({ error: 'Message text is required' });
    }
    if (primaryText.length > 4096) {
      return res.status(400).json({ error: 'Message exceeds 4096 character limit' });
    }

    const mode = ['HTML', 'MarkdownV2'].includes(parse_mode) ? parse_mode : 'HTML';

    let mediaItems = null;
    const mediaPosition = req.body.media_position || 'above';
    if (Array.isArray(req.body.media_items) && req.body.media_items.length > 0) {
      mediaItems = req.body.media_items;
    }

    await sendBroadcastTest(primaryText.trim(), mode, mediaItems, mediaPosition);
    res.json({ success: true });
  } catch (err) {
    console.error('[API] Error sending broadcast test:', err.message);
    res.status(500).json({ error: err.message || 'Failed to send broadcast test' });
  }
});

// POST /api/broadcast/confirmation/send
app.post('/api/broadcast/confirmation/send', authMiddleware, async (req, res) => {
  try {
    const { message_text, parse_mode, messages, buttons } = req.body;

    const primaryText = (messages && messages.en) || message_text;
    if (!primaryText || !primaryText.trim()) {
      return res.status(400).json({ error: 'Message text is required' });
    }
    if (primaryText.length > 4096) {
      return res.status(400).json({ error: 'Message exceeds 4096 character limit' });
    }
    if (!buttons || !Array.isArray(buttons) || buttons.length === 0) {
      return res.status(400).json({ error: 'At least one button is required' });
    }

    const mode = ['HTML', 'MarkdownV2'].includes(parse_mode) ? parse_mode : 'HTML';

    let mediaItems = null;
    const mediaPosition = req.body.media_position || 'above';
    if (Array.isArray(req.body.media_items) && req.body.media_items.length > 0) {
      if (req.body.media_items.length > 10) {
        return res.status(400).json({ error: 'Maximum 10 media items allowed' });
      }
      mediaItems = req.body.media_items;
    }

    const broadcast = await db.createBroadcast({
      type: 'confirmation',
      message_text_en: messages ? messages.en : primaryText.trim(),
      message_text_ru: messages ? messages.ru : null,
      message_text_uz: messages ? messages.uz : null,
      media_items: mediaItems,
      media_position: mediaPosition,
      parse_mode: mode,
      buttons: buttons,
    });

    const results = await sendConfirmationBroadcast(
      primaryText.trim(), mode, messages || null, mediaItems, mediaPosition, buttons, broadcast.id
    );
    res.json({ ...results, broadcast_id: broadcast.id });
  } catch (err) {
    console.error('[API] Error sending confirmation broadcast:', err.message);
    res.status(500).json({ error: err.message || 'Failed to send confirmation broadcast' });
  }
});

// POST /api/broadcast/confirmation/test
app.post('/api/broadcast/confirmation/test', authMiddleware, async (req, res) => {
  try {
    const { message_text, parse_mode, messages, buttons } = req.body;

    const primaryText = (messages && messages.en) || message_text;
    if (!primaryText || !primaryText.trim()) {
      return res.status(400).json({ error: 'Message text is required' });
    }
    if (primaryText.length > 4096) {
      return res.status(400).json({ error: 'Message exceeds 4096 character limit' });
    }

    const mode = ['HTML', 'MarkdownV2'].includes(parse_mode) ? parse_mode : 'HTML';

    let mediaItems = null;
    const mediaPosition = req.body.media_position || 'above';
    if (Array.isArray(req.body.media_items) && req.body.media_items.length > 0) {
      mediaItems = req.body.media_items;
    }

    await sendConfirmationBroadcastTest(primaryText.trim(), mode, mediaItems, mediaPosition, buttons || []);
    res.json({ success: true });
  } catch (err) {
    console.error('[API] Error sending confirmation broadcast test:', err.message);
    res.status(500).json({ error: err.message || 'Failed to send confirmation broadcast test' });
  }
});

// GET /api/broadcasts
app.get('/api/broadcasts', authMiddleware, async (req, res) => {
  try {
    const type = req.query.type || 'regular';
    const broadcasts = await db.getBroadcasts(type);
    res.json(broadcasts);
  } catch (err) {
    console.error('[API] Error fetching broadcasts:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/broadcasts/:id/deliveries
app.get('/api/broadcasts/:id/deliveries', authMiddleware, async (req, res) => {
  try {
    const deliveries = await db.getBroadcastDeliveries(req.params.id);
    res.json(deliveries);
  } catch (err) {
    console.error('[API] Error fetching deliveries:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/broadcasts/:id/clicks
app.get('/api/broadcasts/:id/clicks', authMiddleware, async (req, res) => {
  try {
    const clicks = await db.getBroadcastButtonClicks(req.params.id);
    res.json(clicks);
  } catch (err) {
    console.error('[API] Error fetching button clicks:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Responses Routes ───

// GET /api/responses/:questionId
app.get('/api/responses/:questionId', authMiddleware, async (req, res) => {
  try {
    const responses = await db.getQuestionResponses(req.params.questionId);
    res.json(responses);
  } catch (err) {
    console.error('[API] Error fetching responses:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Scheduled Messages Routes ───

// GET /api/groups/driver-list — all driver groups for targeting UI
app.get('/api/groups/driver-list', authMiddleware, async (req, res) => {
  try {
    const groups = await db.getAllDriverGroups();
    res.json(groups);
  } catch (err) {
    console.error('[API] Error fetching driver groups:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/scheduled-messages — create a scheduled message
app.post('/api/scheduled-messages', authMiddleware, async (req, res) => {
  try {
    const {
      message_text_en, message_text_ru, message_text_uz,
      media_file_id, media_type, media_position,
      target_type, target_driver_ids, target_languages,
      force_language, scheduled_at_chicago,
    } = req.body;

    // Validation
    if (!message_text_en || !message_text_en.trim()) {
      return res.status(400).json({ error: 'English message text is required' });
    }
    if (message_text_en.length > 4096) {
      return res.status(400).json({ error: 'Message exceeds 4096 character limit' });
    }
    if (!scheduled_at_chicago) {
      return res.status(400).json({ error: 'Schedule date/time is required' });
    }

    // Convert Chicago time → UTC
    const chicagoTime = DateTime.fromISO(scheduled_at_chicago, { zone: 'America/Chicago' });
    if (!chicagoTime.isValid) {
      return res.status(400).json({ error: 'Invalid date/time format' });
    }
    if (chicagoTime <= DateTime.now()) {
      return res.status(400).json({ error: 'Scheduled time must be in the future' });
    }
    const scheduledAtUtc = chicagoTime.toUTC().toISO();

    // Validate target_type
    const validTargetTypes = ['all', 'specific_drivers', 'language_groups'];
    const tt = target_type || 'all';
    if (!validTargetTypes.includes(tt)) {
      return res.status(400).json({ error: 'Invalid target_type' });
    }
    if (tt === 'specific_drivers' && (!target_driver_ids || target_driver_ids.length === 0)) {
      return res.status(400).json({ error: 'At least one driver must be selected' });
    }
    if (tt === 'language_groups' && (!target_languages || target_languages.length === 0)) {
      return res.status(400).json({ error: 'At least one language must be selected' });
    }

    // Validate force_language
    if (force_language && !['en', 'ru', 'uz'].includes(force_language)) {
      return res.status(400).json({ error: 'Invalid force_language' });
    }

    const msg = await db.createScheduledMessage({
      message_text_en: message_text_en.trim(),
      message_text_ru: message_text_ru?.trim() || null,
      message_text_uz: message_text_uz?.trim() || null,
      media_file_id: media_file_id || null,
      media_type: media_type || null,
      media_position: media_position || 'above',
      target_type: tt,
      target_driver_ids: target_driver_ids || null,
      target_languages: target_languages || null,
      force_language: force_language || null,
      scheduled_at: scheduledAtUtc,
    });

    console.log(`[API] Scheduled message created: id=${msg.id}, scheduled_at_utc=${scheduledAtUtc}`);
    res.status(201).json(msg);
  } catch (err) {
    console.error('[API] Error creating scheduled message:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/scheduled-messages — list all scheduled messages
app.get('/api/scheduled-messages', authMiddleware, async (req, res) => {
  try {
    const messages = await db.getAllScheduledMessages();
    // Convert UTC → Chicago for display
    const enriched = messages.map(m => ({
      ...m,
      scheduled_at_chicago: DateTime.fromJSDate(new Date(m.scheduled_at))
        .setZone('America/Chicago')
        .toFormat('yyyy-MM-dd HH:mm'),
    }));
    res.json(enriched);
  } catch (err) {
    console.error('[API] Error fetching scheduled messages:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/scheduled-messages/:id/cancel — cancel a pending message
app.put('/api/scheduled-messages/:id/cancel', authMiddleware, async (req, res) => {
  try {
    const msg = await db.getScheduledMessageById(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    if (msg.status !== 'pending') {
      return res.status(400).json({ error: 'Only pending messages can be cancelled' });
    }
    await db.updateScheduledMessageStatus(req.params.id, 'cancelled');
    console.log(`[API] Scheduled message cancelled: id=${req.params.id}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[API] Error cancelling scheduled message:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/scheduled-messages/:id/send-now — send a pending message immediately
app.put('/api/scheduled-messages/:id/send-now', authMiddleware, async (req, res) => {
  try {
    const msg = await db.getScheduledMessageById(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    if (msg.status !== 'pending') {
      return res.status(400).json({ error: 'Only pending messages can be sent' });
    }

    // Resolve target groups
    let groups;
    switch (msg.target_type) {
      case 'specific_drivers':
        groups = await db.getGroupsByIds(msg.target_driver_ids);
        break;
      case 'language_groups':
        groups = await db.getGroupsByLanguages(msg.target_languages);
        break;
      default:
        groups = await db.getAllDriverGroups();
    }

    if (groups.length === 0) {
      await db.updateScheduledMessageStatus(req.params.id, 'failed');
      return res.status(400).json({ error: 'No target groups found' });
    }

    // Build messages
    const en = msg.message_text_en || '';
    const ru = msg.message_text_ru || en;
    const uz = msg.message_text_uz || en;
    let messages;
    if (msg.force_language) {
      const forced = msg.force_language === 'ru' ? ru : msg.force_language === 'uz' ? uz : en;
      messages = { en: forced, ru: forced, uz: forced };
    } else {
      messages = { en, ru, uz };
    }

    const mediaItems = msg.media_file_id
      ? [{ file_id: msg.media_file_id, media_type: msg.media_type || 'photo' }]
      : null;

    const results = await sendBroadcastToGroups(groups, en, 'HTML', messages, mediaItems, msg.media_position);
    await db.updateScheduledMessageStatus(req.params.id, 'sent');

    console.log(`[API] Scheduled message sent now: id=${req.params.id}`);
    res.json({ success: true, sent: results.sent, failed: results.failed });
  } catch (err) {
    console.error('[API] Error sending scheduled message now:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Catch-all for admin SPA ───
app.get('/admin/*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'admin', 'build', 'index.html'));
});

// ─── Start server function ───
let httpServer = null;

function startServer() {
  httpServer = app.listen(config.port, () => {
    console.log(`[API] Server running on port ${config.port}`);
  });
}

function stopServer() {
  if (httpServer) {
    httpServer.close(() => console.log('[API] HTTP server closed.'));
  }
}

module.exports = { app, startServer, stopServer };
