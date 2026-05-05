const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const multer = require('multer');
const config = require('../config/config');
const db = require('../database/db');
const { bot, sendQuestionToGroups, sendTestQuestion, sendBroadcastTest, sendBroadcastToGroups, sendConfirmationBroadcast, sendConfirmationBroadcastTest } = require('../bot/bot');
const { translateBatch } = require('../services/translationService');
const { generateDriverReport, generateCompanyReport, AI_REPORT_GENERATION_FAILED, callYandex } = require('../services/aiAnalysisService');
const { generateInsightReport } = require('../services/aiInsightsService');
const { ensureAnnotationsForRange } = require('../services/aiAnnotationService');
const { askData } = require('../services/aiAskService');
const { inspectDatPageLayout } = require('../services/datUiInspectorService');
const { renderInsightReportForTelegram } = require('../services/insightRenderer');
const { buildTelegramMessageUrl } = require('../services/telegramUrl');
const {
  sanitizeCompanyReportHtmlForTelegram,
  sendTelegramHtmlChunks,
} = require('../services/telegramHtml');
const {
  createConnectSession,
  getSessionByToken,
  buildLoginRedirectForSession,
  finishOAuthCallback,
  connectSelectedPages,
  normalizeSelectedPageIds,
} = require('../services/facebookConnectService');
const {
  enqueueVerifiedFacebookPayload,
  retryFacebookWebhookEvent,
  getFacebookWebhookLog,
} = require('../services/facebookWebhookService');
const { DateTime } = require('luxon');
const {
  DEFAULT_SCHEDULE_TIMEZONE,
  WEEKDAY_LABELS,
  computeNextWeeklyOccurrence,
  describeWeeklySchedule,
  isValidTimezone,
  normalizeMediaItems,
} = require('../services/scheduledMessageUtils');
const { processMessage: processScheduledMessage } = require('../services/schedulerService');
const employeeVotingRoutes = require('./employeeVotingApi');
const dispatchRoutes = require('./routes/dispatchRoutes');

// ─── Multer: memory storage for media uploads ───
const MEDIA_UPLOAD_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime'];
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

const upload = createUploadMiddleware(MEDIA_UPLOAD_MIME_TYPES, 'jpg, png, webp, mp4, mov');
const adminBuildDir = path.join(__dirname, '..', 'admin', 'build');

const app = express();

// ─── CORS ───
// In testing we default to permissive; production should set CORS_ALLOWED_ORIGINS
// to an explicit allow-list (comma-separated). Origin is honored via config.
const corsOptions = config.corsAllowAll
  ? { origin: true }
  : {
      origin(origin, cb) {
        // Non-browser requests (curl, server-to-server) have no Origin header.
        if (!origin) return cb(null, true);
        if (config.corsAllowedOrigins.includes(origin)) return cb(null, true);
        return cb(new Error(`Origin ${origin} not allowed by CORS policy`));
      },
    };
app.use(cors(corsOptions));
app.set('trust proxy', 1); // Render terminates TLS upstream; needed for rate-limit + IP logs.

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
// /leads-log and /retry/:id expose internal lead data — require admin auth.
// The auth check happens via a tiny inline JWT decode so we don't need the
// full authMiddleware (which lives below and depends on express.json()).
function proxyAuthGuard(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

// Serve admin panel static files (production build)
app.use('/admin', express.static(adminBuildDir));

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
    // Pin the algorithm to HS256 so a token forged with alg:"none" or an
    // asymmetric alg cannot impersonate an admin.
    const decoded = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function internalSharedSecretGuard(req, res, next) {
  const provided = String(req.headers['x-internal-shared-secret'] || '');
  if (!provided || provided !== config.leadsInternalSharedSecret) {
    return res.status(401).json({ error: 'Unauthorized internal request' });
  }
  return next();
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderFacebookCardPage(title, bodyHtml) {
  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        --bg: #f3f0e8;
        --ink: #152033;
        --muted: #5d6675;
        --card: rgba(255, 255, 255, 0.84);
        --line: rgba(21, 32, 51, 0.12);
        --primary: #0f766e;
        --primary-ink: #ffffff;
        --accent: #d97706;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: Georgia, "Times New Roman", serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(217, 119, 6, 0.18), transparent 35%),
          radial-gradient(circle at bottom right, rgba(15, 118, 110, 0.18), transparent 30%),
          linear-gradient(160deg, #fbf8f0 0%, var(--bg) 100%);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
      }
      .card {
        width: min(760px, 100%);
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 24px;
        padding: 28px;
        box-shadow: 0 24px 60px rgba(21, 32, 51, 0.14);
        backdrop-filter: blur(8px);
      }
      h1 {
        margin: 0 0 10px;
        font-size: clamp(30px, 4vw, 42px);
        line-height: 1.05;
      }
      p, li, label {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: var(--muted);
        line-height: 1.55;
        font-size: 16px;
      }
      .group {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        margin: 0 0 18px;
        padding: 8px 12px;
        border-radius: 999px;
        background: rgba(15, 118, 110, 0.1);
        color: var(--primary);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-weight: 600;
      }
      .button, button {
        appearance: none;
        border: none;
        border-radius: 999px;
        padding: 14px 22px;
        background: var(--primary);
        color: var(--primary-ink);
        text-decoration: none;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 15px;
        font-weight: 700;
        cursor: pointer;
      }
      .button.secondary {
        background: transparent;
        color: var(--primary);
        border: 1px solid rgba(15, 118, 110, 0.26);
      }
      .stack {
        display: grid;
        gap: 16px;
      }
      .pages {
        display: grid;
        gap: 12px;
        margin: 20px 0;
      }
      .page {
        display: grid;
        gap: 6px;
        padding: 16px 18px;
        border-radius: 18px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.8);
      }
      .page strong {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: var(--ink);
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin-top: 20px;
      }
      .note {
        margin-top: 14px;
        padding: 14px 16px;
        border-left: 4px solid var(--accent);
        background: rgba(217, 119, 6, 0.08);
      }
      input[type="checkbox"] {
        inline-size: 18px;
        block-size: 18px;
        accent-color: var(--primary);
      }
      .checkbox-row {
        display: flex;
        gap: 12px;
        align-items: flex-start;
      }
      .pill {
        display: inline-block;
        margin-right: 8px;
        padding: 4px 10px;
        border-radius: 999px;
        background: rgba(21, 32, 51, 0.06);
        font-size: 12px;
        color: var(--ink);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      @media (max-width: 640px) {
        .card { padding: 22px; }
        .actions { flex-direction: column; }
        .button, button { width: 100%; text-align: center; }
      }
    </style>
  </head>
  <body>
    <div class="card">
      ${bodyHtml}
    </div>
  </body>
  </html>`;
}

function renderConnectLandingPage(session) {
  return renderFacebookCardPage(
    'Connect Facebook',
    `
      <div class="group">Telegram Group: ${escapeHtml(session.group_name || String(session.telegram_group_id))}</div>
      <h1>Connect Facebook Pages</h1>
      <p>Sign in with the Facebook account that manages the Pages you want to connect. After login, you can choose one or many Pages and route their leads into this Telegram group automatically.</p>
      <div class="note">
        <p style="margin:0;">This link is short-lived and tied to one Telegram group. If it expires, send <strong>/connect</strong> in the group again.</p>
      </div>
      <div class="actions">
        <a class="button" href="/facebook/oauth/start?session=${encodeURIComponent(session.session_token)}">Continue With Facebook</a>
      </div>
    `
  );
}

function renderPagePicker(session, profile, pages) {
  const pageCards = pages.map((page) => `
    <label class="page">
      <span class="checkbox-row">
        <input type="checkbox" name="page_id" value="${escapeHtml(page.id)}" checked>
        <span>
          <strong>${escapeHtml(page.name)}</strong><br>
          ${(page.tasks || []).map((task) => `<span class="pill">${escapeHtml(task)}</span>`).join('')}
        </span>
      </span>
    </label>
  `).join('');

  return renderFacebookCardPage(
    'Choose Pages',
    `
      <div class="group">Telegram Group: ${escapeHtml(session.group_name || String(session.telegram_group_id))}</div>
      <h1>Choose the Pages to connect</h1>
      <p>Signed in as <strong>${escapeHtml(profile?.name || session.oauth_user_name || 'Facebook user')}</strong>. Every Page you keep checked below will send new leads into this Telegram group.</p>
      <form method="POST" action="/facebook/connect/${encodeURIComponent(session.session_token)}/select-pages" class="stack">
        <div class="pages">
          ${pageCards}
        </div>
        <div class="actions">
          <button type="submit">Connect Selected Pages</button>
          <a class="button secondary" href="/facebook/connect/${encodeURIComponent(session.session_token)}">Start Over</a>
        </div>
      </form>
    `
  );
}

function renderConnectResultPage({ title, message, detailLines = [] }) {
  return renderFacebookCardPage(
    title,
    `
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
      ${detailLines.length ? `<div class="note"><p style="margin:0; white-space:pre-line;">${escapeHtml(detailLines.join('\n'))}</p></div>` : ''}
    `
  );
}

// ─── Login Rate Limiter (in-memory sliding window) ───
// Simple per-IP throttle: 10 failed attempts in 15 minutes → 429.
// Memory-only is acceptable for a single-dyno deployment; swap for a
// shared store (Redis) before horizontal scaling.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
const loginAttempts = new Map(); // ip -> [timestamps]

function loginRateLimit(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const attempts = (loginAttempts.get(ip) || []).filter((ts) => now - ts < LOGIN_WINDOW_MS);
  if (attempts.length >= LOGIN_MAX_FAILURES) {
    res.set('Retry-After', String(Math.ceil(LOGIN_WINDOW_MS / 1000)));
    return res.status(429).json({ error: 'Too many failed login attempts. Try again later.' });
  }
  loginAttempts.set(ip, attempts);
  req._loginIp = ip;
  next();
}

function recordLoginFailure(req) {
  const ip = req._loginIp;
  if (!ip) return;
  const attempts = loginAttempts.get(ip) || [];
  attempts.push(Date.now());
  loginAttempts.set(ip, attempts);
}

function clearLoginFailures(req) {
  if (req._loginIp) loginAttempts.delete(req._loginIp);
}

function isLoopbackRequest(req) {
  const candidates = [
    req.ip,
    req.socket?.remoteAddress,
    req.connection?.remoteAddress,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  return candidates.some((value) => (
    value === '::1'
    || value === '127.0.0.1'
    || value === '::ffff:127.0.0.1'
  ));
}

// ─── Auth Routes ───

// POST /api/auth/login
app.post('/api/auth/login', loginRateLimit, async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string'
        || !username.trim() || !password) {
      recordLoginFailure(req);
      return res.status(400).json({ error: 'Username and password required' });
    }

    const admin = await db.getAdminByUsername(username);
    if (!admin) {
      recordLoginFailure(req);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) {
      recordLoginFailure(req);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: admin.id, username: admin.username },
      config.jwtSecret,
      { algorithm: 'HS256', expiresIn: '24h' }
    );

    clearLoginFailures(req);
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
// Pings the DB so a healthy response genuinely means the app can serve
// requests, not just that Node is alive. Render / uptime monitors treat
// any non-2xx as "down" which will now actually reflect reality.
app.get('/api/health', async (req, res) => {
  let dbOk = false;
  try {
    dbOk = await db.ping();
  } catch (err) {
    console.error('[API] /api/health DB ping failed:', err.message);
  }
  const body = {
    status: dbOk ? 'ok' : 'degraded',
    uptime: process.uptime(),
    db: dbOk,
  };
  res.status(dbOk ? 200 : 503).json(body);
});

app.post('/api/dat-ui/inspect', async (req, res) => {
  try {
    if (!isLoopbackRequest(req)) {
      return res.status(403).json({ error: 'DAT UI inspector is only available from localhost' });
    }

    const estimatedSize = Buffer.byteLength(JSON.stringify(req.body || {}), 'utf8');
    if (estimatedSize > 50_000) {
      return res.status(413).json({ error: 'Snapshot too large' });
    }

    const snapshot = req.body?.snapshot && typeof req.body.snapshot === 'object'
      ? {
          ...req.body.snapshot,
          url: req.body.snapshot.url || req.body?.url || '',
          signature: req.body.snapshot.signature || req.body?.signature || '',
          currentConfig: req.body.snapshot.currentConfig || req.body?.currentConfig || null,
        }
      : (req.body && typeof req.body === 'object' ? req.body : null);

    if (!snapshot) {
      return res.status(400).json({ error: 'snapshot object is required' });
    }

    const inspection = await inspectDatPageLayout(snapshot);
    return res.json({
      ok: true,
      ...inspection,
    });
  } catch (err) {
    console.error('[API] DAT UI inspect failed:', err.message);
    return res.status(500).json({
      ok: false,
      error: 'Failed to inspect DAT UI snapshot',
      detail: err.message,
    });
  }
});

// Avoid noisy browser console 404 for default favicon requests.
app.get('/favicon.ico', (req, res) => {
  res.status(204).end();
});

app.post('/api/internal/facebook/webhook-events', internalSharedSecretGuard, async (req, res) => {
  try {
    const result = await enqueueVerifiedFacebookPayload(req.body || {});
    res.json({ status: 'accepted', ...result });
  } catch (err) {
    console.error('[API] Facebook internal webhook ingest failed:', err.message);
    res.status(500).json({ error: 'Failed to ingest Facebook webhook payload', detail: err.message });
  }
});

app.post('/api/internal/facebook/connect-command', internalSharedSecretGuard, async (req, res) => {
  try {
    const telegramGroupId = Number(req.body?.telegramGroupId);
    const groupName = typeof req.body?.groupName === 'string' ? req.body.groupName : 'Unknown';
    if (!Number.isFinite(telegramGroupId)) {
      return res.status(400).json({ error: 'telegramGroupId is required' });
    }

    const { connectUrl, session } = await createConnectSession({
      telegramGroupId,
      groupName,
      requestedBy: {
        id: req.body?.requestedBy?.id || null,
        name: req.body?.requestedBy?.name || 'Unknown',
      },
    });

    const existingConnections = await db.getFacebookPageConnectionsByTelegramGroupId(telegramGroupId);
    return res.json({
      status: 'ok',
      connectUrl,
      sessionToken: session.session_token,
      existingPages: existingConnections.map((page) => ({
        pageId: page.page_id,
        pageName: page.page_name,
        isActive: page.is_active,
      })),
    });
  } catch (err) {
    console.error('[API] Facebook connect command setup failed:', err.message);
    return res.status(500).json({ error: 'Could not create Facebook connect session', detail: err.message });
  }
});

app.get('/facebook/connect/:sessionToken', async (req, res) => {
  try {
    const session = await getSessionByToken(req.params.sessionToken);
    res.send(renderConnectLandingPage(session));
  } catch (err) {
    res.status(400).send(
      renderConnectResultPage({
        title: 'Connect Link Unavailable',
        message: err.message,
      })
    );
  }
});

app.get('/facebook/oauth/start', async (req, res) => {
  try {
    const redirectUrl = await buildLoginRedirectForSession(req.query.session);
    res.redirect(302, redirectUrl);
  } catch (err) {
    res.status(400).send(
      renderConnectResultPage({
        title: 'Facebook Login Could Not Start',
        message: err.message,
      })
    );
  }
});

app.get('/facebook/oauth/callback', async (req, res) => {
  try {
    if (req.query.error) {
      throw new Error(req.query.error_description || req.query.error || 'Facebook login was cancelled');
    }
    const { session, profile, pages } = await finishOAuthCallback({
      state: req.query.state,
      code: req.query.code,
    });

    if (!pages.length) {
      res.status(400).send(
        renderConnectResultPage({
          title: 'No Pages Available',
          message: 'Facebook did not return any Pages for this account. Make sure this Facebook account has Page access and that the app was granted the right permissions.',
        })
      );
      return;
    }

    res.send(renderPagePicker(session, profile, pages));
  } catch (err) {
    console.error('[API] Facebook OAuth callback failed:', err.message);
    res.status(400).send(
      renderConnectResultPage({
        title: 'Facebook Login Failed',
        message: err.message,
      })
    );
  }
});

app.post('/facebook/connect/:sessionToken/select-pages', async (req, res) => {
  try {
    const selectedPageIds = normalizeSelectedPageIds(req.body.page_id);
    const { session, results } = await connectSelectedPages({
      sessionToken: req.params.sessionToken,
      selectedPageIds,
    });

    const successful = results.filter((result) => result.subscriptionStatus !== 'subscription_failed');
    const detailLines = results.map((result) => {
      const prefix = result.subscriptionStatus === 'subscription_failed' ? 'Failed' : 'Connected';
      const pageName = result.connection?.page_name || 'Unknown Page';
      const detail = result.subscriptionError ? ` (${result.subscriptionError})` : '';
      return `${prefix}: ${pageName}${detail}`;
    });

    try {
      await bot.telegram.sendMessage(
        session.telegram_group_id,
        [
          'Facebook Page connection updated.',
          '',
          ...detailLines,
        ].join('\n')
      );
    } catch (sendErr) {
      console.error('[API] Could not post Facebook connect confirmation to Telegram:', sendErr.message);
      detailLines.push(`Telegram confirmation warning: ${sendErr.message}`);
    }

    res.send(
      renderConnectResultPage({
        title: successful.length ? 'Facebook Connected' : 'Facebook Connection Saved With Warnings',
        message: successful.length
          ? 'Your selected Pages are now connected to this Telegram group.'
          : 'The flow completed, but no Pages reported a clean subscription result. Review the details below.',
        detailLines,
      })
    );
  } catch (err) {
    console.error('[API] Facebook page selection failed:', err.message);
    res.status(400).send(
      renderConnectResultPage({
        title: 'Could Not Save Page Selection',
        message: err.message,
      })
    );
  }
});

app.get('/leads-log', proxyAuthGuard, async (req, res) => {
  try {
    const entries = await getFacebookWebhookLog(50);
    res.json({ count: entries.length, entries });
  } catch (err) {
    console.error('[API] Error loading Facebook leads log:', err.message);
    res.status(500).json({ error: 'Failed to load Facebook leads log', detail: err.message });
  }
});

app.get('/retry/:id', proxyAuthGuard, async (req, res) => {
  try {
    const event = await retryFacebookWebhookEvent(req.params.id);
    if (!event) {
      return res.status(404).json({ error: 'No Facebook webhook event found for that identifier' });
    }
    return res.json({ success: true, event });
  } catch (err) {
    console.error('[API] Error retrying Facebook webhook event:', err.message);
    return res.status(500).json({ error: 'Failed to retry Facebook webhook event', detail: err.message });
  }
});

function getNormalizedMediaItemsFromBody(body) {
  if (!Array.isArray(body?.media_items) || body.media_items.length === 0) {
    return null;
  }

  if (body.media_items.length > 10) {
    throw new Error('Maximum 10 media items allowed');
  }

  const normalized = normalizeMediaItems(body.media_items);
  if (normalized.length !== body.media_items.length) {
    throw new Error('Each media item must include a valid file_id and media type');
  }

  return normalized;
}

function formatScheduledMessageForResponse(msg) {
  const timezone = msg.schedule_timezone || DEFAULT_SCHEDULE_TIMEZONE;
  const nextRunChicago = DateTime.fromJSDate(new Date(msg.scheduled_at))
    .setZone(timezone)
    .toFormat('yyyy-MM-dd HH:mm');

  const mediaItems = normalizeMediaItems(msg.media_items);
  const mediaCount = mediaItems.length || (msg.media_file_id ? 1 : 0);

  return {
    ...msg,
    media_items: mediaItems.length ? mediaItems : msg.media_items,
    media_count: mediaCount,
    scheduled_at_chicago: nextRunChicago,
    schedule_type: msg.schedule_type || 'one_time',
    schedule_timezone: timezone,
    schedule_label: (msg.schedule_type || 'one_time') === 'weekly'
      ? describeWeeklySchedule(msg.weekly_day_of_week, msg.weekly_time_local, timezone)
      : `One time on ${nextRunChicago}`,
    weekly_day_label: msg.weekly_day_of_week ? WEEKDAY_LABELS[msg.weekly_day_of_week] || null : null,
    last_sent_at_chicago: msg.last_sent_at
      ? DateTime.fromJSDate(new Date(msg.last_sent_at)).setZone(timezone).toFormat('yyyy-MM-dd HH:mm')
      : null,
  };
}

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
      const mediaStorageChatId = config.mediaStorageChatId;

      let sentMessage;
      if (isVideo) {
        sentMessage = await bot.telegram.sendVideo(mediaStorageChatId, fileSource, {
          disable_notification: true,
          caption: 'Upload staging for file_id capture.',
        });
      } else {
        sentMessage = await bot.telegram.sendPhoto(mediaStorageChatId, fileSource, {
          disable_notification: true,
          caption: 'Upload staging for file_id capture.',
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

      try {
        await bot.telegram.deleteMessage(mediaStorageChatId, sentMessage.message_id);
      } catch (deleteErr) {
        console.warn('[API] Failed to delete staged media message:', deleteErr.message);
        try {
          await bot.telegram.editMessageCaption(
            mediaStorageChatId,
            sentMessage.message_id,
            undefined,
            'Staged media for upcoming broadcast.',
            { parse_mode: 'HTML' }
          );
        } catch (editErr) {
          console.warn('[API] Failed to edit staged media caption:', editErr.message);
        }
      }

      if (!fileId) {
        return res.status(500).json({ error: 'Failed to retrieve file_id from Telegram' });
      }

      console.log(`[API] Media uploaded: type=${mediaType}, file_id=${fileId}`);
      res.json({ file_id: fileId, media_type: mediaType, type: mediaType, url: null });
    } catch (uploadErr) {
      console.error('[API] Media upload error:', uploadErr.message);
      res.status(500).json({ error: 'Failed to upload media to Telegram. Check bot permissions.' });
    }
  });
});

// ─── Groups Routes ───

app.use('/api/dispatch', dispatchRoutes);

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

// PUT /api/groups/:id/birthday
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
app.put('/api/groups/:id/birthday', authMiddleware, async (req, res) => {
  try {
    const { birthday } = req.body || {};
    // Allow explicit null to clear, otherwise require strict YYYY-MM-DD.
    if (birthday !== null && birthday !== undefined) {
      if (typeof birthday !== 'string' || !ISO_DATE_RE.test(birthday)) {
        return res.status(400).json({ error: 'birthday must be a YYYY-MM-DD date or null' });
      }
      const d = new Date(birthday);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({ error: 'birthday is not a valid calendar date' });
      }
    }
    const group = await db.setGroupBirthday(req.params.id, birthday ?? null);
    if (!group) {
      return res.status(404).json({ error: 'Group not found' });
    }
    res.json(group);
  } catch (err) {
    console.error('[API] Error updating group birthday:', err.message);
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
    try {
      mediaItems = getNormalizedMediaItemsFromBody(req.body);
    } catch (mediaErr) {
      return res.status(400).json({ error: mediaErr.message });
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
    try {
      mediaItems = getNormalizedMediaItemsFromBody(req.body);
    } catch (mediaErr) {
      return res.status(400).json({ error: mediaErr.message });
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

async function resolveBroadcastTargetGroups(body) {
  if (!body.target_type && Array.isArray(body.group_ids) && body.group_ids.length > 0) {
    return db.getGroupsByIds(body.group_ids);
  }
  const tt = body.target_type || 'all';
  if (tt === 'specific_drivers') {
    const ids = body.target_driver_ids;
    if (!Array.isArray(ids) || ids.length === 0) return [];
    return db.getGroupsByIds(ids);
  }
  if (tt === 'language_groups') {
    const langs = body.target_languages;
    if (!Array.isArray(langs) || langs.length === 0) return [];
    return db.getGroupsByLanguages(langs);
  }
  return db.getAllDriverGroups();
}

// POST /api/broadcast/send
app.post('/api/broadcast/send', authMiddleware, async (req, res) => {
  try {
    const {
      message_text,
      parse_mode,
      messages,
      target_type,
      target_driver_ids,
      target_languages,
      force_language,
    } = req.body;

    let normalizedTargetType = target_type || 'all';
    let storedDriverIds = target_driver_ids;
    let storedLanguages = target_languages;
    if (!target_type && Array.isArray(req.body.group_ids) && req.body.group_ids.length > 0) {
      normalizedTargetType = 'specific_drivers';
      storedDriverIds = req.body.group_ids;
    }

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
    try {
      mediaItems = getNormalizedMediaItemsFromBody(req.body);
    } catch (mediaErr) {
      return res.status(400).json({ error: mediaErr.message });
    }

    const targetGroups = await resolveBroadcastTargetGroups({
      ...req.body,
      target_type: normalizedTargetType,
      target_driver_ids: storedDriverIds,
      target_languages: storedLanguages,
    });
    if (!targetGroups || targetGroups.length === 0) {
      return res.status(400).json({ error: 'No valid target groups found. Broadcast aborted.' });
    }

    const broadcast = await db.createBroadcast({
      type: 'regular',
      message_text_en: messages ? messages.en : primaryText.trim(),
      message_text_ru: messages ? messages.ru : null,
      message_text_uz: messages ? messages.uz : null,
      media_items: mediaItems,
      media_position: mediaPosition,
      parse_mode: mode,
      target_type: normalizedTargetType,
      target_driver_ids: storedDriverIds || null,
      target_languages: storedLanguages || null,
      force_language: force_language || null,
    });

    const results = await sendBroadcastToGroups(
      targetGroups,
      primaryText.trim(),
      mode,
      messages || null,
      mediaItems,
      mediaPosition,
      broadcast.id,
      force_language || null
    );
    res.json({ ...results, broadcast_id: broadcast.id });
  } catch (err) {
    console.error('[API] Error sending broadcast:', err.message);
    res.status(500).json({ error: err.message || 'Failed to send broadcast' });
  }
});

// POST /api/broadcast/test
app.post('/api/broadcast/test', authMiddleware, async (req, res) => {
  try {
    const { message_text, parse_mode, messages, force_language } = req.body;

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
    try {
      mediaItems = getNormalizedMediaItemsFromBody(req.body);
    } catch (mediaErr) {
      return res.status(400).json({ error: mediaErr.message });
    }

    await sendBroadcastTest(
      primaryText.trim(),
      mode,
      messages || null,
      mediaItems,
      mediaPosition,
      force_language || null
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[API] Error sending broadcast test:', err.message);
    res.status(500).json({ error: err.message || 'Failed to send broadcast test' });
  }
});

// POST /api/broadcast/confirmation/send
app.post('/api/broadcast/confirmation/send', authMiddleware, async (req, res) => {
  try {
    const {
      message_text,
      parse_mode,
      messages,
      buttons,
      target_type,
      target_driver_ids,
      target_languages,
      force_language,
    } = req.body;

    let normalizedTargetType = target_type || 'all';
    let storedDriverIds = target_driver_ids;
    let storedLanguages = target_languages;
    if (!target_type && Array.isArray(req.body.group_ids) && req.body.group_ids.length > 0) {
      normalizedTargetType = 'specific_drivers';
      storedDriverIds = req.body.group_ids;
    }

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
    try {
      mediaItems = getNormalizedMediaItemsFromBody(req.body);
    } catch (mediaErr) {
      return res.status(400).json({ error: mediaErr.message });
    }

    const targetGroups = await resolveBroadcastTargetGroups({
      ...req.body,
      target_type: normalizedTargetType,
      target_driver_ids: storedDriverIds,
      target_languages: storedLanguages,
    });
    if (!targetGroups || targetGroups.length === 0) {
      return res.status(400).json({ error: 'No valid target groups found. Broadcast aborted.' });
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
      target_type: normalizedTargetType,
      target_driver_ids: storedDriverIds || null,
      target_languages: storedLanguages || null,
      force_language: force_language || null,
    });

    const results = await sendConfirmationBroadcast(
      primaryText.trim(),
      mode,
      messages || null,
      mediaItems,
      mediaPosition,
      buttons,
      broadcast.id,
      targetGroups,
      force_language || null
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
    const { message_text, parse_mode, messages, buttons, force_language } = req.body;

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
    try {
      mediaItems = getNormalizedMediaItemsFromBody(req.body);
    } catch (mediaErr) {
      return res.status(400).json({ error: mediaErr.message });
    }

    await sendConfirmationBroadcastTest(
      primaryText.trim(),
      mode,
      messages || null,
      mediaItems,
      mediaPosition,
      buttons || [],
      force_language || null
    );
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
      schedule_type, schedule_timezone,
      weekly_day_of_week, weekly_time_chicago,
    } = req.body;

    // Validation
    if (!message_text_en || !message_text_en.trim()) {
      return res.status(400).json({ error: 'English message text is required' });
    }
    if (message_text_en.length > 4096) {
      return res.status(400).json({ error: 'Message exceeds 4096 character limit' });
    }
    const scheduleType = schedule_type === 'weekly' ? 'weekly' : 'one_time';
    const scheduleTimezone = schedule_timezone || DEFAULT_SCHEDULE_TIMEZONE;
    if (!isValidTimezone(scheduleTimezone)) {
      return res.status(400).json({ error: 'Invalid schedule_timezone' });
    }

    // Convert Chicago time → UTC
    let scheduledAtUtc;
    if (scheduleType === 'weekly') {
      if (!weekly_day_of_week || !weekly_time_chicago) {
        return res.status(400).json({ error: 'weekly_day_of_week and weekly_time_chicago are required for weekly schedules' });
      }
      const nextOccurrence = computeNextWeeklyOccurrence({
        dayOfWeek: weekly_day_of_week,
        timeOfDay: weekly_time_chicago,
        timezone: scheduleTimezone,
      });
      if (!nextOccurrence) {
        return res.status(400).json({ error: 'Invalid weekly schedule configuration' });
      }
      scheduledAtUtc = nextOccurrence.toUTC().toISO();
    } else {
      if (!scheduled_at_chicago) {
        return res.status(400).json({ error: 'Schedule date/time is required' });
      }
      const localScheduledTime = DateTime.fromISO(scheduled_at_chicago, { zone: scheduleTimezone });
      if (!localScheduledTime.isValid) {
        return res.status(400).json({ error: 'Invalid date/time format' });
      }
      if (localScheduledTime <= DateTime.now().setZone(scheduleTimezone)) {
        return res.status(400).json({ error: 'Scheduled time must be in the future' });
      }
      scheduledAtUtc = localScheduledTime.toUTC().toISO();
    }

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

    let mediaItems = null;
    try {
      mediaItems = getNormalizedMediaItemsFromBody(req.body);
    } catch (mediaErr) {
      return res.status(400).json({ error: mediaErr.message });
    }

    const msg = await db.createScheduledMessage({
      message_text_en: message_text_en.trim(),
      message_text_ru: message_text_ru?.trim() || null,
      message_text_uz: message_text_uz?.trim() || null,
      media_items: mediaItems,
      media_file_id: media_file_id || mediaItems?.[0]?.file_id || null,
      media_type: media_type || mediaItems?.[0]?.media_type || null,
      media_position: media_position || 'above',
      target_type: tt,
      target_driver_ids: target_driver_ids || null,
      target_languages: target_languages || null,
      force_language: force_language || null,
      scheduled_at: scheduledAtUtc,
      schedule_type: scheduleType,
      schedule_timezone: scheduleTimezone,
      weekly_day_of_week: scheduleType === 'weekly' ? parseInt(weekly_day_of_week, 10) : null,
      weekly_time_local: scheduleType === 'weekly' ? weekly_time_chicago : null,
    });

    console.log(`[API] Scheduled message created: id=${msg.id}, scheduled_at_utc=${scheduledAtUtc}`);
    res.status(201).json(formatScheduledMessageForResponse(msg));
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
    const enriched = messages.map(formatScheduledMessageForResponse);
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

    const locked = await db.claimScheduledMessage(req.params.id);
    if (!locked) {
      return res.status(409).json({ error: 'Scheduled message is already being processed' });
    }

    const results = await processScheduledMessage(locked);
    console.log(`[API] Scheduled message sent now: id=${req.params.id}`);
    res.json({
      success: results.status !== 'failed',
      sent: results.sent,
      failed: results.failed,
      status: results.status,
      next_run_at: results.next_run_at || null,
    });
  } catch (err) {
    console.error('[API] Error sending scheduled message now:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Chat Logs Route ───
app.get('/api/chat-logs', authMiddleware, async (req, res) => {
  try {
    const logs = await db.getRecentChatLogs(50);
    res.json(logs);
  } catch (err) {
    console.error('[API] Error fetching chat logs:', err.message);
    res.status(500).json({ error: 'Failed to fetch chat logs' });
  }
});

// ─── AI Reports (HITL) ───
app.get('/api/ai-reports', authMiddleware, async (req, res) => {
  try {
    const type = req.query.type === 'company' ? 'company' : 'driver';
    const includeSent = req.query.includeSent === 'true';
    let reports;
    if (includeSent) {
      const result = await db.query(
        `SELECT ar.*, COALESCE(g.group_name, 'Global Driver Groups') AS group_name
         FROM ai_reports ar
         LEFT JOIN groups g ON g.id = ar.group_id
         WHERE ar.report_type = $1
         ORDER BY ar.generated_at DESC
         LIMIT 100`,
        [type]
      );
      reports = result.rows;
    } else {
      reports = await db.getPendingAiReports(type);
    }
    res.json(reports);
  } catch (err) {
    console.error('[API] Error fetching AI reports:', err.message);
    res.status(500).json({ error: 'Failed to fetch AI reports' });
  }
});

app.post('/api/ai-reports/generate', authMiddleware, async (req, res) => {
  try {
    const reportType = req.body.reportType === 'company' ? 'company' : 'driver';
    const groupId = parseInt(req.body.groupId, 10);
    const daysBack = parseInt(req.body.daysBack, 10);

    if (!Number.isInteger(daysBack) || daysBack < 1 || daysBack > 30) {
      return res.status(400).json({ error: 'daysBack must be an integer between 1 and 30' });
    }

    if (reportType === 'driver' && (!Number.isInteger(groupId) || groupId <= 0)) {
      return res.status(400).json({ error: 'Invalid groupId for driver report' });
    }

    let logs = [];
    let reportText = '';
    let reportGroupId = null;

    if (reportType === 'company') {
      logs = await db.getChatLogsForActiveDriverGroups(daysBack);
    } else {
      const groupRes = await db.query(
        `SELECT id, group_name FROM groups WHERE id = $1 AND group_type = 'driver' AND active = TRUE`,
        [groupId]
      );
      const group = groupRes.rows[0];
      if (!group) {
        return res.status(404).json({ error: 'Group not found' });
      }
      reportGroupId = group.id;
      logs = await db.getChatLogsForGroup(group.id, daysBack);
    }

    if (!logs || logs.length === 0) {
      return res.status(400).json({ error: 'No logs found in the selected date range' });
    }

    // Legacy logs may lack telegram_message_id: omit [Link: ...] but never drop the row.
    const transcriptReadyLogs = logs.map((log) => {
      const link = buildTelegramMessageUrl(log.telegram_group_id, log.telegram_message_id);
      const rawText = log.message_text;
      const messageText = rawText == null || rawText === ''
        ? '(no message text)'
        : String(rawText).replace(/\s+/g, ' ').trim();
      const senderName = String(log.sender_name || 'Unknown');
      const groupName = String(log.group_name || 'Unknown Group');
      const linkPrefix = link ? `[Link: ${link}] ` : '';
      const transcript_line = link
        ? `[Group: ${groupName}] ${linkPrefix}${senderName}: ${messageText}`
        : `[Group: ${groupName}] ${senderName}: ${messageText}`;
      return {
        ...log,
        transcript_line,
      };
    });

    if (reportType === 'company') {
      reportText = await generateCompanyReport(transcriptReadyLogs);
    } else {
      reportText = await generateDriverReport(transcriptReadyLogs);
    }

    if (!reportText || reportText === AI_REPORT_GENERATION_FAILED) {
      return res.status(502).json({ error: 'AI report generation failed' });
    }

    const draft = await db.saveAiReport(reportGroupId, reportText, reportType);
    const hydrated = await db.getAiReportById(draft.id);
    res.status(201).json(hydrated || draft);
  } catch (err) {
    console.error('[API] Error generating AI report:', err.message);
    res.status(500).json({ error: 'Failed to generate AI report' });
  }
});

app.post('/api/ai-reports/:id/send', authMiddleware, async (req, res) => {
  try {
    const reportId = parseInt(req.params.id, 10);
    if (!Number.isInteger(reportId) || reportId <= 0) {
      return res.status(400).json({ error: 'Invalid report id' });
    }

    const report = await db.getAiReportById(reportId);
    if (!report) {
      return res.status(404).json({ error: 'Report not found' });
    }
    if (report.status !== 'draft') {
      return res.status(400).json({ error: 'Only draft reports can be sent' });
    }

    const escapeHtml = (text) => String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    const sourceText = typeof req.body?.editedText === 'string' && req.body.editedText.trim()
      ? req.body.editedText
      : report.report_text;
    let message = '';
    if (report.report_type === 'company') {
      const [overallRaw, breakdownRaw] = String(sourceText || '').split('|||');
      const companyBody = breakdownRaw
        ? `${sanitizeCompanyReportHtmlForTelegram(overallRaw)}\n\n${sanitizeCompanyReportHtmlForTelegram(breakdownRaw)}`
        : sanitizeCompanyReportHtmlForTelegram(sourceText);
      message = [
        '📊 <b>Company AI Weekly Dispatch Report (Admin Approved)</b>',
        `<b>Generated:</b> ${escapeHtml(new Date(report.generated_at).toLocaleString())}`,
        '',
        companyBody || 'Report unavailable.',
      ].join('\n');
    } else {
      const [overallRaw, breakdownRaw] = String(sourceText || '').split('|||');
      const overallSummary = (overallRaw || '').trim() || 'Summary unavailable.';
      const driverBreakdown = (breakdownRaw || '').trim() || 'Driver breakdown unavailable.';
      message = [
        '📊 <b>AI Chat Analysis (Admin Approved)</b>',
        `<b>Group:</b> ${escapeHtml(report.group_name)}`,
        `<b>Generated:</b> ${escapeHtml(new Date(report.generated_at).toLocaleString())}`,
        '',
        `<b>Overall Summary</b>`,
        escapeHtml(overallSummary),
        '',
        `<b>Driver Breakdown</b>`,
        `<blockquote expandable>${escapeHtml(driverBreakdown)}</blockquote>`,
      ].join('\n');
    }

    await sendTelegramHtmlChunks(bot.telegram, config.managementGroupId, message);

    await db.updateAiReportStatus(reportId, 'sent');
    res.json({ success: true });
  } catch (err) {
    const detail = err.response?.description || err.message;
    console.error('[API] Error sending AI report:', detail);
    res.status(500).json({
      error: 'Failed to send AI report to management group',
      detail,
    });
  }
});

app.delete('/api/ai-reports/:id', authMiddleware, async (req, res) => {
  try {
    const reportId = parseInt(req.params.id, 10);
    if (!Number.isInteger(reportId) || reportId <= 0) {
      return res.status(400).json({ error: 'Invalid report id' });
    }
    const report = await db.getAiReportById(reportId);
    if (!report) {
      return res.status(404).json({ error: 'Report not found' });
    }
    if (report.status !== 'draft') {
      return res.status(400).json({ error: 'Only draft reports can be discarded' });
    }
    await db.discardAiReport(reportId);
    res.json({ success: true });
  } catch (err) {
    console.error('[API] Error discarding AI report:', err.message);
    res.status(500).json({ error: 'Failed to discard AI report' });
  }
});

app.post('/api/ai-reports/test-yandex', authMiddleware, async (req, res) => {
  try {
    const output = await callYandex('Reply with exactly: YANDEX_OK');
    const ok = output.includes('YANDEX_OK');
    res.json({ success: ok, output: output.slice(0, 200) });
  } catch (err) {
    console.error('[API] Yandex AI test failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── AI Insights v2 (card-based reports) ─────────────────────────
// Generates a brand-new insights report: annotates any missing chat_logs in
// the window, rebuilds role consensus, computes per-sender stats, runs the
// nine detectors, and asks Yandex for a narrative per non-empty card.
app.post('/api/ai-insights/generate', authMiddleware, async (req, res) => {
  try {
    const daysBack = parseInt(req.body?.daysBack, 10);
    if (!Number.isInteger(daysBack) || daysBack < 1 || daysBack > 30) {
      return res.status(400).json({ error: 'daysBack must be an integer between 1 and 30' });
    }
    const result = await generateInsightReport({
      daysBack,
      reportType: 'company',
    });
    if (!result.report) {
      return res.status(400).json({ error: result.reason || 'No messages in range to analyze' });
    }
    res.status(201).json({
      report: result.report,
      cards: await db.getInsightsForReport(result.report.id),
      pulse: result.pulse,
    });
  } catch (err) {
    console.error('[API] Insight generation failed:', err.message);
    res.status(500).json({ error: 'Failed to generate insight report', detail: err.message });
  }
});

// Lists reports produced by the new insights pipeline (format="insights_v2").
app.get('/api/ai-insights/reports', authMiddleware, async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const rows = await db.query(
      `SELECT id, group_id, report_text, report_type, status, generated_at, sent_at
         FROM ai_reports
        WHERE report_type = 'company'
          AND report_text LIKE '%"format":"insights_v2"%'
        ORDER BY generated_at DESC
        LIMIT $1`,
      [limit]
    );
    res.json(rows.rows.map((r) => {
      let meta = null;
      try { meta = JSON.parse(r.report_text); } catch (_) { /* noop */ }
      return { ...r, meta };
    }));
  } catch (err) {
    console.error('[API] List insights reports failed:', err.message);
    res.status(500).json({ error: 'Failed to list insight reports' });
  }
});

// Returns the full card set for a given report.
app.get('/api/ai-insights/reports/:id', authMiddleware, async (req, res) => {
  try {
    const reportId = parseInt(req.params.id, 10);
    if (!Number.isInteger(reportId) || reportId <= 0) {
      return res.status(400).json({ error: 'Invalid report id' });
    }
    const report = await db.getAiReportById(reportId);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    const cards = await db.getInsightsForReport(reportId);
    let meta = null;
    try { meta = JSON.parse(report.report_text); } catch (_) { /* noop */ }
    res.json({ report, cards, meta });
  } catch (err) {
    console.error('[API] Get insights report failed:', err.message);
    res.status(500).json({ error: 'Failed to load insight report' });
  }
});

// Per-card approve / dismiss / edit / feedback.
app.put('/api/ai-insights/cards/:id', authMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid card id' });
    }
    const { status, feedback, patch } = req.body || {};
    const allowed = ['pending', 'approved', 'dismissed', 'edited'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
    }
    const existing = await db.getInsightById(id);
    if (!existing) return res.status(404).json({ error: 'Card not found' });
    const updated = await db.updateInsightStatus(id, status, feedback || null, patch || null);
    res.json(updated);
  } catch (err) {
    console.error('[API] Update insight card failed:', err.message);
    res.status(500).json({ error: 'Failed to update insight card' });
  }
});

// Send the (approved) subset of a report to management group.
app.post('/api/ai-insights/reports/:id/send', authMiddleware, async (req, res) => {
  try {
    const reportId = parseInt(req.params.id, 10);
    if (!Number.isInteger(reportId) || reportId <= 0) {
      return res.status(400).json({ error: 'Invalid report id' });
    }
    const report = await db.getAiReportById(reportId);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    const allCards = await db.getInsightsForReport(reportId);
    // Include anything not explicitly dismissed — "pending" is treated as OK-to-send
    // to match the live-preview UX. If the user wants stricter behavior, they can
    // approve each card first.
    const cards = allCards.filter((c) => c.status !== 'dismissed');
    if (!cards.length) {
      return res.status(400).json({ error: 'No cards to send (all dismissed)' });
    }
    let meta = {};
    try { meta = JSON.parse(report.report_text); } catch (_) { /* noop */ }
    const html = renderInsightReportForTelegram({
      report,
      cards,
      pulse: meta.pulse || { days_back: meta.days_back || 7 },
    });
    const safe = sanitizeCompanyReportHtmlForTelegram(html);
    await sendTelegramHtmlChunks(bot.telegram, config.managementGroupId, safe);
    await db.updateAiReportStatus(reportId, 'sent');
    for (const c of cards) {
      if (c.status !== 'sent') {
        await db.updateInsightStatus(c.id, 'sent');
      }
    }
    res.json({ success: true, sent_cards: cards.length });
  } catch (err) {
    const detail = err.response?.description || err.message;
    console.error('[API] Send insight report failed:', detail);
    res.status(500).json({ error: 'Failed to send insight report', detail });
  }
});

// Manual annotation backfill (for Ask-the-Data freshness).
app.post('/api/ai-insights/annotate', authMiddleware, async (req, res) => {
  try {
    const daysBack = parseInt(req.body?.daysBack, 10);
    if (!Number.isInteger(daysBack) || daysBack < 1 || daysBack > 90) {
      return res.status(400).json({ error: 'daysBack must be an integer between 1 and 90' });
    }
    const result = await ensureAnnotationsForRange({ daysBack });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[API] Annotation backfill failed:', err.message);
    res.status(500).json({ error: 'Annotation backfill failed', detail: err.message });
  }
});

// ─── Ask the Data (natural-language → plan → SQL → narrative) ────
app.post('/api/ai-ask', authMiddleware, async (req, res) => {
  try {
    const question = typeof req.body?.question === 'string' ? req.body.question : '';
    if (!question.trim()) return res.status(400).json({ error: 'question is required' });
    const result = await askData(question);
    res.json(result);
  } catch (err) {
    console.error('[API] Ask the data failed:', err.message);
    res.status(500).json({ error: 'Ask the data failed', detail: err.message });
  }
});

// ─── Message Manager (Edit/Delete via Link) ───
function parseTgUrl(url) {
  try {
    // Matches private links: [https://t.me/c/1234567890/5044](https://t.me/c/1234567890/5044)
    const privateMatch = url.match(/t\.me\/c\/(\d+)\/(\d+)/);
    if (privateMatch) return { chatId: `-100${privateMatch[1]}`, messageId: parseInt(privateMatch[2], 10) };

    // Matches public links: [https://t.me/groupname/5044](https://t.me/groupname/5044)
    const publicMatch = url.match(/t\.me\/([a-zA-Z0-9_]+)\/(\d+)/);
    if (publicMatch) return { chatId: `@${publicMatch[1]}`, messageId: parseInt(publicMatch[2], 10) };

    return null;
  } catch (e) { return null; }
}

app.post('/api/message/delete', authMiddleware, async (req, res) => {
  try {
    const { url } = req.body;
    const parsed = parseTgUrl(url);
    if (!parsed) return res.status(400).json({ error: 'Invalid Telegram message URL format.' });

    await bot.telegram.deleteMessage(parsed.chatId, parsed.messageId);
    res.json({ success: true });
  } catch (err) {
    console.error('[API] Error deleting message:', err.message);
    res.status(500).json({ error: err.message || 'Failed to delete message' });
  }
});

app.post('/api/message/edit', authMiddleware, async (req, res) => {
  try {
    const { url, newText } = req.body;
    if (!newText) return res.status(400).json({ error: 'New text is required.' });

    const parsed = parseTgUrl(url);
    if (!parsed) return res.status(400).json({ error: 'Invalid Telegram message URL format.' });

    try {
      // Attempt to edit as a standard text message
      await bot.telegram.editMessageText(parsed.chatId, parsed.messageId, undefined, newText, { parse_mode: 'HTML', disable_web_page_preview: true });
    } catch (editErr) {
      // If it fails because the message has media, attempt to edit the caption instead
      if (editErr.description && editErr.description.includes('there is no text in the message to edit')) {
         await bot.telegram.editMessageCaption(parsed.chatId, parsed.messageId, undefined, newText, { parse_mode: 'HTML' });
      } else {
         throw editErr;
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[API] Error editing message:', err.message);
    res.status(500).json({ error: err.message || 'Failed to edit message' });
  }
});

// ─── Employee Birthdays ───

// 1. Mini Web App Landing Page (Public)
app.get('/employee-birthday-form', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
      <title>Employee Birthday</title>
      <style>
        body { font-family: -apple-system, sans-serif; background: #0f1117; color: #fff; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
        .card { background: #1e2230; padding: 24px; border-radius: 12px; width: 90%; max-width: 400px; box-shadow: 0 4px 20px rgba(0,0,0,0.3); }
        input { width: 100%; padding: 14px; margin-bottom: 16px; border-radius: 8px; border: 1px solid #2d3348; background: #252a3a; color: #fff; box-sizing: border-box; font-size: 16px; }
        button { width: 100%; padding: 14px; background: #6366f1; color: #fff; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; font-size: 16px; }
        .step { display: none; }
        .step.active { display: block; animation: fadeIn 0.3s; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
      </style>
    </head>
    <body>
      <div class="card">
        <h2 style="margin-top: 0;">🎂 Your Birthday</h2>
        <div id="step1" class="step active">
          <label style="display:block; margin-bottom:8px; color:#94a3b8;">First Name</label>
          <input type="text" id="fn" placeholder="Enter your first name" />
          <button onclick="next(1)">Next ➔</button>
        </div>
        <div id="step2" class="step">
          <label style="display:block; margin-bottom:8px; color:#94a3b8;">Last Name</label>
          <input type="text" id="ln" placeholder="Enter your last name" />
          <button onclick="next(2)">Next ➔</button>
        </div>
        <div id="step3" class="step">
          <label style="display:block; margin-bottom:8px; color:#94a3b8;">Select your Birthday</label>
          <input type="date" id="bday" />
          <button onclick="submitForm()" id="submitBtn">Submit ✅</button>
        </div>
        <div id="step4" class="step" style="text-align: center;">
          <h2 style="font-size: 40px; margin: 10px 0;">🎉</h2>
          <h3>All Set!</h3>
          <p style="color: #94a3b8;">Your birthday has been recorded. You can close this page now.</p>
        </div>
      </div>
      <script>
        function next(step) {
          if(step === 1 && !document.getElementById('fn').value.trim()) return alert('Please enter your first name.');
          if(step === 2 && !document.getElementById('ln').value.trim()) return alert('Please enter your last name.');
          document.querySelectorAll('.step').forEach(e => e.classList.remove('active'));
          document.getElementById('step' + (step + 1)).classList.add('active');
        }
        async function submitForm() {
          const fn = document.getElementById('fn').value.trim();
          const ln = document.getElementById('ln').value.trim();
          const bd = document.getElementById('bday').value;
          if(!bd) return alert('Please select your birthday.');
          
          document.getElementById('submitBtn').innerText = 'Submitting...';
          document.getElementById('submitBtn').disabled = true;
          
          try {
            const res = await fetch('/api/submit-employee-birthday', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ firstName: fn, lastName: ln, birthday: bd })
            });
            if(res.ok) next(3);
            else alert('Error submitting. Please try again.');
          } catch(e) { alert('Network error.'); }
        }
      </script>
    </body>
    </html>
  `);
});

// 2. Submit Route (Public)
app.post('/api/submit-employee-birthday', async (req, res) => {
  try {
    const { firstName, lastName, birthday } = req.body || {};

    if (typeof firstName !== 'string' || typeof lastName !== 'string'
        || typeof birthday !== 'string') {
      return res.status(400).json({ error: 'Missing fields' });
    }
    const fn = firstName.trim();
    const ln = lastName.trim();
    if (!fn || !ln) return res.status(400).json({ error: 'Missing fields' });
    if (fn.length > 100 || ln.length > 100) {
      return res.status(400).json({ error: 'Name too long' });
    }
    if (!ISO_DATE_RE.test(birthday)) {
      return res.status(400).json({ error: 'birthday must be YYYY-MM-DD' });
    }
    const d = new Date(birthday);
    if (Number.isNaN(d.getTime())) {
      return res.status(400).json({ error: 'birthday is not a valid calendar date' });
    }

    await db.upsertEmployeeBirthday(fn, ln, birthday);
    res.json({ success: true });
  } catch (err) {
    console.error('[API] Error saving employee birthday:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// 3. Get All Employee Birthdays (Protected Admin)
app.get('/api/employee-birthdays', authMiddleware, async (req, res) => {
  try {
    const data = await db.getAllEmployeeBirthdays();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// 4. Trigger Bot Request Message (Protected Admin)
app.post('/api/employee-birthdays/request', authMiddleware, async (req, res) => {
  try {
    if (!config.employeeGroupId) return res.status(400).json({ error: 'EMPLOYEE_GROUP_ID not configured in .env' });
    const { Markup } = require('telegraf');
    const appUrl = process.env.RENDER_EXTERNAL_URL || 'https://wenze-bots.onrender.com';
    const keyboard = Markup.inlineKeyboard([
      Markup.button.url('🎂 Enter Your Birthday', `${appUrl}/employee-birthday-form`)
    ]);
    const msg = `Hey Team! 👋\n\nWe'd love to celebrate your special day! Please take 10 seconds to click the button below and enter your birthday.`;
    await bot.telegram.sendMessage(config.employeeGroupId, msg, { parse_mode: 'HTML', ...keyboard });
    res.json({ success: true });
  } catch (err) {
    console.error('[API] Error sending birthday request:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 5. Update Employee (Protected Admin)
app.put('/api/employee-birthdays/:id', authMiddleware, async (req, res) => {
  try {
    const { firstName, lastName, birthday } = req.body;
    if (!firstName || !lastName || !birthday) return res.status(400).json({ error: 'Missing fields' });
    const updated = await db.updateEmployeeBirthday(req.params.id, firstName, lastName, birthday);
    res.json(updated);
  } catch (err) {
    console.error('[API] Error updating employee birthday:', err.message);
    res.status(500).json({ error: 'Failed to update employee' });
  }
});

// 6. Delete Employee (Protected Admin)
app.delete('/api/employee-birthdays/:id', authMiddleware, async (req, res) => {
  try {
    await db.deleteEmployeeBirthday(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('[API] Error deleting employee birthday:', err.message);
    res.status(500).json({ error: 'Failed to delete employee' });
  }
});

// ─── Catch-all for admin SPA ───
app.get(['/admin', '/admin/*', '/dispatch', '/dispatch/*'], (req, res) => {
  res.sendFile(path.join(adminBuildDir, 'index.html'));
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



