'use strict';

/**
 * The hosted SOS/QBQ presentation: pages, persistent edits, and the remote link.
 *
 * Two routers, mounted separately in server/api.js:
 *
 *   pageRouter — GET /qbq, /qbq/remote and /qbq/assets/*. Public, HTML/JS only.
 *   apiRouter  — /api/qbq/*. Reading is public; SAVING requires the same
 *                full-admin gate as every other admin endpoint.
 *
 * Deliberate omissions from the logs: pairing codes, session tokens, and
 * presentation text. A pairing code is a live credential for the length of a
 * talk and a token is one for hours, so neither is ever written out, and the
 * SSE route's query string is never echoed into a log line.
 */

const express = require('express');
const path = require('node:path');

const qbqDb = require('../../database/qbqPresentation');
const { parseElementPath, InvalidElementPathError } = require('../../services/qbq/elementPath');
const {
  sanitizeEditableText,
  InvalidEditableTextError,
} = require('../../services/qbq/sanitizeEditableText');
const remoteSessions = require('../../services/qbq/remoteSessions');
const { QbqSessionError } = require('../../services/qbq/remoteSessions');
const { RateLimiter } = require('../../services/qbq/rateLimiter');
const { renderPresentation } = require('../qbq/template');

const PUBLIC_DIR = path.join(__dirname, '..', 'qbq', 'public');
const REMOTE_HTML = path.join(__dirname, '..', 'qbq', 'remote.html');

// Pairing is the sensitive one: a 6-character code is short enough to grind at
// from a script, so one address gets ten tries per five minutes. The per-code
// burn in remoteSessions handles a targeted guess; this handles the sweep.
const pairLimiter = new RateLimiter({ windowMs: 5 * 60 * 1000, max: 10 });
const sessionLimiter = new RateLimiter({ windowMs: 5 * 60 * 1000, max: 20 });
// Generous — this is a human tapping "next" on a phone, and throttling a
// presenter mid-talk is a worse failure than a burst of commands.
const commandLimiter = new RateLimiter({ windowMs: 60 * 1000, max: 300 });
const saveLimiter = new RateLimiter({ windowMs: 5 * 60 * 1000, max: 60 });

/** Never trust a proxy header for identity; express `trust proxy` is set in api.js. */
const clientKey = (req) => req.ip || req.socket?.remoteAddress || 'unknown';

function limit(limiter, req, res) {
  const { limited, retryAfterSec } = limiter.check(clientKey(req));
  if (!limited) return false;
  res.setHeader('Retry-After', String(retryAfterSec));
  res.status(429).json({ error: 'Too many attempts, please try again later.', code: 'RATE_LIMITED' });
  return true;
}

/** Bearer for POSTs; ?token= for EventSource, which cannot send headers. */
function readSessionToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  const q = req.query?.token;
  return typeof q === 'string' ? q.trim() : '';
}

function sendSessionError(res, err) {
  if (err instanceof QbqSessionError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  console.error('[QBQ] session error:', err.message);
  return res.status(500).json({ error: 'Remote session failed', code: 'SESSION_FAILED' });
}

// ─── Pages ──────────────────────────────────────────────────────────────────

function createQbqPageRoutes() {
  const router = express.Router();

  /**
   * The presentation itself.
   *
   * `no-store` is load-bearing: saved overrides are inlined into the document,
   * so a cached copy would show a presenter their pre-edit wording after a
   * refresh and look exactly like a lost save.
   */
  async function presentationHandler(req, res) {
    let overrides = [];
    try {
      overrides = await qbqDb.listOverrides();
    } catch (err) {
      // A database blip must not take the deck off the projector. The page
      // still renders; it just renders the template's original wording.
      console.error('[QBQ] could not load saved edits, serving template text:', err.message);
    }

    let rendered;
    try {
      rendered = renderPresentation({ overrides });
    } catch (err) {
      console.error('[QBQ] presentation template unavailable:', err.message);
      return res.status(404).type('text/plain').send('Presentation not found.');
    }
    if (!rendered.substituted) {
      console.error('[QBQ] LOCAL-SAVE sentinels missing or duplicated — served template unchanged.');
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.type('html').send(rendered.html);
  }

  router.get('/qbq', presentationHandler);
  router.get('/qbq/', presentationHandler);

  function remoteHandler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    return res.sendFile(REMOTE_HTML, (err) => {
      if (err && !res.headersSent) {
        res.status(404).type('text/plain').send('Remote controller not found.');
      }
    });
  }

  router.get('/qbq/remote', remoteHandler);
  router.get('/qbq/remote/', remoteHandler);

  // Static client scripts. express.static resolves inside PUBLIC_DIR only, so
  // there is no traversal path out of it, and remote.html deliberately lives
  // one directory up so it is not reachable here.
  router.use('/qbq/assets', express.static(PUBLIC_DIR, {
    maxAge: '5m',
    index: false,
    dotfiles: 'ignore',
    extensions: false,
  }));

  return router;
}

// ─── API ────────────────────────────────────────────────────────────────────

/**
 * @param {object} deps
 * @param {Function|Function[]} deps.authMiddleware full-admin guard from api.js
 */
function createQbqApiRoutes({ authMiddleware }) {
  const router = express.Router();

  // ── Persistent presentation edits ──

  /** Public: reading the presentation, and its saved text, stays public. */
  router.get('/content', async (req, res) => {
    try {
      const overrides = await qbqDb.listOverrides();
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ deckKey: qbqDb.DEFAULT_DECK_KEY, overrides });
    } catch (err) {
      console.error('[QBQ] content read failed:', err.message);
      return res.status(500).json({ error: 'Could not load saved edits', code: 'READ_FAILED' });
    }
  });

  /**
   * Save one element's text. Full admin only.
   *
   * Validation order matters: the path and the text are both checked BEFORE
   * anything touches the database, so a rejected save never opens a
   * transaction and the previously stored row is untouched by construction.
   */
  router.put('/content', authMiddleware, async (req, res) => {
    if (limit(saveLimiter, req, res)) return undefined;

    let parsed;
    let content;
    try {
      parsed = parseElementPath(req.body?.elementPath);
      content = sanitizeEditableText(req.body?.content);
    } catch (err) {
      if (err instanceof InvalidElementPathError || err instanceof InvalidEditableTextError) {
        return res.status(400).json({ error: err.message, code: err.code });
      }
      throw err;
    }

    try {
      const saved = await qbqDb.upsertOverride({
        elementPath: parsed.elementPath,
        slideIndex: parsed.slideIndex,
        content,
        adminId: req.admin?.id ?? null,
      });
      return res.json({ saved });
    } catch (err) {
      // Deliberately does NOT log `content`: presentation text is the user's
      // material, and a failed write is not a reason to copy it into a log.
      console.error('[QBQ] save failed for %s: %s', parsed.elementPath, err.message);
      return res.status(500).json({ error: 'Could not save the change', code: 'SAVE_FAILED' });
    }
  });

  // ── Remote pairing and live control ──

  /** Presenter opens a session and gets a code to read out. */
  router.post('/session', (req, res) => {
    if (limit(sessionLimiter, req, res)) return undefined;
    try {
      return res.status(201).json(remoteSessions.createSession());
    } catch (err) {
      return sendSessionError(res, err);
    }
  });

  /** Presenter asks for a fresh code (the old one expired or was overheard). */
  router.post('/session/code', (req, res) => {
    if (limit(sessionLimiter, req, res)) return undefined;
    try {
      return res.json(remoteSessions.issueCode(readSessionToken(req)));
    } catch (err) {
      return sendSessionError(res, err);
    }
  });

  /** Remote exchanges the code for a token. Hard-limited; codes burn on abuse. */
  router.post('/pair', (req, res) => {
    if (limit(pairLimiter, req, res)) return undefined;
    try {
      return res.json(remoteSessions.pair(req.body?.code));
    } catch (err) {
      return sendSessionError(res, err);
    }
  });

  /** Presenter reports where the deck actually is. */
  router.post('/state', (req, res) => {
    try {
      const state = remoteSessions.updateState(readSessionToken(req), req.body || {});
      return res.json({ state });
    } catch (err) {
      return sendSessionError(res, err);
    }
  });

  /** Remote taps a button. `seq` makes a retry harmless. */
  router.post('/command', (req, res) => {
    if (limit(commandLimiter, req, res)) return undefined;
    try {
      const result = remoteSessions.submitCommand(readSessionToken(req), {
        action: req.body?.action,
        seq: req.body?.seq,
      });
      return res.json(result);
    } catch (err) {
      return sendSessionError(res, err);
    }
  });

  router.post('/disconnect', (req, res) => {
    try {
      return res.json(remoteSessions.disconnect(readSessionToken(req)));
    } catch (err) {
      return sendSessionError(res, err);
    }
  });

  /**
   * One SSE endpoint for both roles; the token decides which events arrive.
   *
   * The token rides in the query string because EventSource cannot set headers.
   * These are ephemeral session tokens, not permanent secrets — they die with
   * the session — and nothing here logs the URL or the query.
   */
  router.get('/stream', (req, res) => {
    let subscription;
    try {
      subscription = remoteSessions.subscribe(readSessionToken(req), send);
    } catch (err) {
      return sendSessionError(res, err);
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Render's proxy buffers by default, which would hold every command until
      // the response ended. This turns that off for this response.
      'X-Accel-Buffering': 'no',
    });
    res.write(': ok\n\n');

    // A reconnecting or refreshed remote must land on the presenter's CURRENT
    // slide, so the first thing on a new stream is always a state snapshot.
    send({ type: 'state', role: subscription.role, state: subscription.state });

    const heartbeat = setInterval(() => {
      try {
        res.write(': hb\n\n');
      } catch {
        /* the close handler does the cleanup */
      }
    }, 25000);
    heartbeat.unref?.();

    const cleanup = () => {
      clearInterval(heartbeat);
      subscription.unsubscribe();
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
    return undefined;

    function send(event) {
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        /* client vanished mid-write; close handler cleans up */
      }
    }
  });

  return router;
}

module.exports = {
  createQbqPageRoutes,
  createQbqApiRoutes,
  // Exposed so tests can start from a known-clean limiter state.
  __limitersForTests: { pairLimiter, sessionLimiter, commandLimiter, saveLimiter },
};
