/**
 * QBQ / SOS employee assessment — HTTP routes.
 *
 * Exports three routers:
 *  - publicRouter      (mounted at /api/sos, NO auth): the REAL flow.
 *  - publicTestRouter  (mounted at /api/sos/test, NO auth): the isolated TEST
 *    flow used by /questions/test and /answers/test. Identical endpoints built
 *    by the same factory — the ONLY difference is the mode flag threaded into
 *    the service, so test requests can only ever touch is_test=TRUE rows.
 *  - adminRouter       (mounted at /api/sos/admin BEFORE the public routers,
 *    behind legacyAuthMiddleware): status for both modes, independent
 *    open/close switches, mode-filtered submissions list (+CSV), per-answer
 *    detail, delete, and SEPARATE clear-test / clear-real operations with
 *    different confirmation phrases.
 *
 * Individual answers and names are served ONLY through the admin router.
 * The test-data cleanup control on /answers/test calls the admin clear-test
 * endpoint with an admin JWT — there is no unauthenticated destructive API.
 */

const express = require('express');
const sos = require('../../services/sosAssessment');
const { toCsv } = require('./csvSafe');

function sendServiceError(res, err, fallback = 'Request failed') {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('[SOS API]', err.message);
  return res.status(status).json({ error: err.message || fallback, code: err.code, ...(err.extra || {}) });
}

// Light in-memory sliding-window limiter for the unauthenticated write path.
// Buckets are per mode+IP so rehearsals on the test page cannot consume the
// real questionnaire's budget for an office IP (and vice versa).
const SUBMIT_WINDOW_MS = 15 * 60 * 1000;
const SUBMIT_MAX_PER_WINDOW = 12;
const submitHits = new Map();

function submitRateLimited(bucket) {
  const now = Date.now();
  const hits = (submitHits.get(bucket) || []).filter((t) => now - t < SUBMIT_WINDOW_MS);
  if (hits.length >= SUBMIT_MAX_PER_WINDOW) return true;
  hits.push(now);
  submitHits.set(bucket, hits);
  if (submitHits.size > 5000) submitHits.clear(); // bound memory on abuse
  return false;
}

/** The public flow, parameterized ONLY by mode. */
function buildPublicRouter(isTest) {
  const router = express.Router();

  router.get('/meta', async (req, res) => {
    try {
      res.json(await sos.getMeta(isTest));
    } catch (err) {
      sendServiceError(res, err, 'Could not load the questionnaire.');
    }
  });

  router.get('/questionnaire', async (req, res) => {
    try {
      res.json(await sos.getQuestionnaire(String(req.query.department || ''), isTest));
    } catch (err) {
      sendServiceError(res, err, 'Could not load the questions.');
    }
  });

  router.post('/submissions', async (req, res) => {
    try {
      const ip = req.ip || 'unknown';
      if (submitRateLimited(`${isTest ? 'test' : 'real'}:${ip}`)) {
        return res.status(429).json({ error: 'Too many attempts, please try again later.', code: 'RATE_LIMITED' });
      }
      const body = req.body || {};
      const result = await sos.submitAssessment({
        fullName: body.fullName,
        department: body.department,
        dispatchTeamId: body.dispatchTeamId,
        language: body.language,
        contentVersion: body.contentVersion,
        answers: body.answers,
        confirmDuplicate: body.confirmDuplicate === true,
        clientIp: ip,
        isTest,
      });
      res.status(201).json(result);
    } catch (err) {
      sendServiceError(res, err, 'Could not save your answers.');
    }
  });

  router.get('/results/:token', async (req, res) => {
    try {
      res.json(await sos.getResultByToken(req.params.token, isTest));
    } catch (err) {
      sendServiceError(res, err, 'Result not found.');
    }
  });

  router.get('/summary', async (req, res) => {
    try {
      res.json(await sos.getPublicSummary(isTest));
    } catch (err) {
      sendServiceError(res, err, 'Could not load the summary.');
    }
  });

  return router;
}

const publicRouter = buildPublicRouter(false);
const publicTestRouter = buildPublicRouter(true);

// ─────────────────────────────── Admin ───────────────────────────────

const adminRouter = express.Router();

function parseMode(raw, fallback = 'real') {
  const mode = String(raw || fallback);
  if (!['real', 'test', 'all'].includes(mode)) return null;
  return mode;
}

adminRouter.get('/status', async (req, res) => {
  try {
    res.json(await sos.getAdminStatus());
  } catch (err) {
    sendServiceError(res, err);
  }
});

adminRouter.put('/status', async (req, res) => {
  try {
    if (typeof req.body?.open !== 'boolean') {
      return res.status(400).json({ error: 'Body must include { open: boolean }' });
    }
    const mode = parseMode(req.body?.mode, 'real');
    if (mode !== 'real' && mode !== 'test') {
      return res.status(400).json({ error: 'mode must be "real" or "test"' });
    }
    const settings = await sos.setOpen(req.body.open, mode === 'test');
    res.json({ open: settings.isOpen, testOpen: settings.testIsOpen, updatedAt: settings.updatedAt });
  } catch (err) {
    sendServiceError(res, err);
  }
});

adminRouter.get('/submissions', async (req, res) => {
  try {
    const mode = parseMode(req.query.mode);
    if (!mode) return res.status(400).json({ error: 'mode must be real, test, or all' });
    const rows = await sos.listSubmissions({
      department: req.query.department || undefined,
      dispatchTeamId: req.query.teamId ? Number.parseInt(req.query.teamId, 10) : undefined,
      pattern: req.query.pattern || undefined,
      search: req.query.search || undefined,
      mode,
    });
    if (req.query.format === 'csv') {
      const csv = toCsv(rows.map((r) => ({
        id: r.id,
        mode: r.isTest ? 'test' : 'real',
        full_name: r.fullName,
        department: r.department,
        dispatch_team: r.dispatchTeamName || '',
        language: r.language,
        primary_pattern: r.primaryPattern,
        secondary_pattern: r.secondaryPattern || '',
        victim: r.patternScores.victim,
        complaint: r.patternScores.complaint,
        waiting: r.patternScores.waiting,
        blame: r.patternScores.blame,
        ownership: r.patternScores.ownership,
        builder: r.patternScores.builder,
        duplicate_count: r.duplicateCount,
        submitted_at: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
      })));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="sos-submissions-${mode}.csv"`);
      return res.send(csv);
    }
    res.json({ mode, submissions: rows });
  } catch (err) {
    sendServiceError(res, err);
  }
});

adminRouter.get('/submissions/:id', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
    res.json(await sos.getAdminSubmissionDetail(id));
  } catch (err) {
    sendServiceError(res, err);
  }
});

adminRouter.delete('/submissions/:id', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
    const deleted = await sos.deleteSubmission(id);
    if (!deleted) return res.status(404).json({ error: 'Submission not found' });
    res.json({ deleted: true });
  } catch (err) {
    sendServiceError(res, err);
  }
});

// TEST cleanup: deletes ONLY is_test=TRUE rows. Used by the admin panel and by
// the cleanup control on /answers/test (which authenticates with an admin JWT
// through this same guarded router — no unauthenticated destructive API).
adminRouter.post('/clear-test', async (req, res) => {
  try {
    if (req.body?.confirm !== 'DELETE TEST DATA') {
      return res.status(400).json({ error: 'Send { confirm: "DELETE TEST DATA" } to clear the TEST submissions.' });
    }
    const deleted = await sos.clearSubmissions(true);
    res.json({ deleted, mode: 'test' });
  } catch (err) {
    sendServiceError(res, err);
  }
});

// REAL cleanup: intentionally a DIFFERENT endpoint with a DIFFERENT phrase so
// no test-cleanup code path can ever reach it.
adminRouter.post('/clear-real', async (req, res) => {
  try {
    if (req.body?.confirm !== 'DELETE ALL REAL SUBMISSIONS') {
      return res.status(400).json({ error: 'Send { confirm: "DELETE ALL REAL SUBMISSIONS" } to clear the REAL submissions.' });
    }
    const deleted = await sos.clearSubmissions(false);
    res.json({ deleted, mode: 'real' });
  } catch (err) {
    sendServiceError(res, err);
  }
});

module.exports = { publicRouter, publicTestRouter, adminRouter };
