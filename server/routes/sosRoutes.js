/**
 * QBQ / SOS employee assessment — HTTP routes.
 *
 * Exports two routers (raiseRoutes.js pattern):
 *  - publicRouter (mounted at /api/sos, NO auth): meta, department
 *    questionnaire (whitelisted payload — never contains scoring data),
 *    submission, personal result by capability token, anonymous summary.
 *  - adminRouter (mounted at /api/sos/admin BEFORE the public router, behind
 *    legacyAuthMiddleware): status, open/close, submissions list (+CSV),
 *    per-answer detail, delete, clear-all.
 *
 * Individual answers and names are served ONLY through the admin router.
 */

const express = require('express');
const sos = require('../../services/sosAssessment');
const { toCsv } = require('./csvSafe');

const publicRouter = express.Router();
const adminRouter = express.Router();

function sendServiceError(res, err, fallback = 'Request failed') {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('[SOS API]', err.message);
  return res.status(status).json({ error: err.message || fallback, code: err.code, ...(err.extra || {}) });
}

// Light in-memory sliding-window limiter for the unauthenticated write path.
const SUBMIT_WINDOW_MS = 15 * 60 * 1000;
const SUBMIT_MAX_PER_WINDOW = 12;
const submitHits = new Map();

function submitRateLimited(ip) {
  const now = Date.now();
  const hits = (submitHits.get(ip) || []).filter((t) => now - t < SUBMIT_WINDOW_MS);
  if (hits.length >= SUBMIT_MAX_PER_WINDOW) return true;
  hits.push(now);
  submitHits.set(ip, hits);
  if (submitHits.size > 5000) submitHits.clear(); // bound memory on abuse
  return false;
}

// ─────────────────────────────── Public ───────────────────────────────

publicRouter.get('/meta', async (req, res) => {
  try {
    res.json(await sos.getMeta());
  } catch (err) {
    sendServiceError(res, err, 'Could not load the questionnaire.');
  }
});

publicRouter.get('/questionnaire', async (req, res) => {
  try {
    res.json(await sos.getQuestionnaire(String(req.query.department || '')));
  } catch (err) {
    sendServiceError(res, err, 'Could not load the questions.');
  }
});

publicRouter.post('/submissions', async (req, res) => {
  try {
    const ip = req.ip || 'unknown';
    if (submitRateLimited(ip)) {
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
    });
    res.status(201).json(result);
  } catch (err) {
    sendServiceError(res, err, 'Could not save your answers.');
  }
});

publicRouter.get('/results/:token', async (req, res) => {
  try {
    res.json(await sos.getResultByToken(req.params.token));
  } catch (err) {
    sendServiceError(res, err, 'Result not found.');
  }
});

publicRouter.get('/summary', async (req, res) => {
  try {
    res.json(await sos.getPublicSummary());
  } catch (err) {
    sendServiceError(res, err, 'Could not load the summary.');
  }
});

// ─────────────────────────────── Admin ───────────────────────────────

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
    const settings = await sos.setOpen(req.body.open);
    res.json({ open: settings.isOpen, updatedAt: settings.updatedAt });
  } catch (err) {
    sendServiceError(res, err);
  }
});

adminRouter.get('/submissions', async (req, res) => {
  try {
    const rows = await sos.listSubmissions({
      department: req.query.department || undefined,
      dispatchTeamId: req.query.teamId ? Number.parseInt(req.query.teamId, 10) : undefined,
      pattern: req.query.pattern || undefined,
      search: req.query.search || undefined,
    });
    if (req.query.format === 'csv') {
      const csv = toCsv(rows.map((r) => ({
        id: r.id,
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
      res.setHeader('Content-Disposition', 'attachment; filename="sos-submissions.csv"');
      return res.send(csv);
    }
    res.json({ submissions: rows });
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

adminRouter.post('/clear', async (req, res) => {
  try {
    if (req.body?.confirm !== 'DELETE ALL') {
      return res.status(400).json({ error: 'Send { confirm: "DELETE ALL" } to clear every submission.' });
    }
    const deleted = await sos.clearAllSubmissions();
    res.json({ deleted });
  } catch (err) {
    sendServiceError(res, err);
  }
});

module.exports = { publicRouter, adminRouter };
