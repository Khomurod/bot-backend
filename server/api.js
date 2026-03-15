const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const config = require('../config/config');
const db = require('../database/db');
const { sendQuestionToGroups, sendTestQuestion } = require('../bot/bot');

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

    const question = await db.createQuestion(translations, options);
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

    await sendTestQuestion(question_en.trim(), options_en.map((o) => o.trim()));
    res.json({ success: true });
  } catch (err) {
    console.error('[API] Error sending test question:', err.message);
    res.status(500).json({ error: err.message || 'Failed to send test question' });
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
