const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const multer = require('multer');
const config = require('../config/config');
const db = require('../database/db');
const { bot, sendQuestionToGroups, sendTestQuestion, sendBroadcast, sendBroadcastTest } = require('../bot/bot');
const { translateBatch } = require('../services/translationService');

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
app.use(express.json({ limit: '1mb' }));

// Serve admin panel static files (production build)
app.use('/admin', express.static(path.join(__dirname, '..', 'admin', 'build')));

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
      if (err.code === 'LIMIT_FILE_SIZE') {
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
    const { translations, options, media_file_id, media_type, media_position } = req.body;

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

    // Optional media — validate if provided
    let media = null;
    if (media_file_id) {
      if (media_type && !['photo', 'video'].includes(media_type)) {
        return res.status(400).json({ error: 'media_type must be photo or video' });
      }
      if (media_position && !['above', 'below'].includes(media_position)) {
        return res.status(400).json({ error: 'media_position must be above or below' });
      }
      media = { file_id: media_file_id, type: media_type || 'photo', position: media_position || 'above' };
    }

    const question = await db.createQuestion(translations, options, media);
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
    const { question_en, options_en, media_file_id, media_type, media_position } = req.body;

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

    const media = media_file_id ? { file_id: media_file_id, type: media_type || 'photo', position: media_position || 'above' } : null;
    await sendTestQuestion(question_en.trim(), options_en.map((o) => o.trim()), media);
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
    const { message_text, parse_mode, messages, media_file_id, media_type, media_position } = req.body;

    // Backward compatible: accept either messages object or message_text
    const primaryText = (messages && messages.en) || message_text;

    if (!primaryText || !primaryText.trim()) {
      return res.status(400).json({ error: 'Message text is required' });
    }

    if (primaryText.length > 4096) {
      return res.status(400).json({ error: 'Message exceeds 4096 character limit' });
    }

    const mode = ['HTML', 'MarkdownV2'].includes(parse_mode) ? parse_mode : 'HTML';
    const media = media_file_id ? { file_id: media_file_id, type: media_type || 'photo', position: media_position || 'above' } : null;

    const results = await sendBroadcast(primaryText.trim(), mode, messages || null, media);
    res.json(results);
  } catch (err) {
    console.error('[API] Error sending broadcast:', err.message);
    res.status(500).json({ error: err.message || 'Failed to send broadcast' });
  }
});

// POST /api/broadcast/test
app.post('/api/broadcast/test', authMiddleware, async (req, res) => {
  try {
    const { message_text, parse_mode, messages, media_file_id, media_type, media_position } = req.body;

    const primaryText = (messages && messages.en) || message_text;

    if (!primaryText || !primaryText.trim()) {
      return res.status(400).json({ error: 'Message text is required' });
    }

    if (primaryText.length > 4096) {
      return res.status(400).json({ error: 'Message exceeds 4096 character limit' });
    }

    const mode = ['HTML', 'MarkdownV2'].includes(parse_mode) ? parse_mode : 'HTML';
    const media = media_file_id ? { file_id: media_file_id, type: media_type || 'photo', position: media_position || 'above' } : null;

    await sendBroadcastTest(primaryText.trim(), mode, media);
    res.json({ success: true });
  } catch (err) {
    console.error('[API] Error sending broadcast test:', err.message);
    res.status(500).json({ error: err.message || 'Failed to send broadcast test' });
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

// ─── Catch-all for admin SPA ───
app.get('/admin/*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'admin', 'build', 'index.html'));
});

// ─── Start server function ───
function startServer() {
  app.listen(config.port, () => {
    console.log(`[API] Server running on port ${config.port}`);
  });
}

module.exports = { app, startServer };
