const express = require('express');
const { DateTime } = require('luxon');
const rc = require('../../database/ringcentral');
const { syncNow } = require('../../services/recruiterCallSyncService');
const { createRecruiterConnectLink } = require('../../services/ringCentralConnectService');
const { clearRecruiterTokenCache } = require('../../services/ringCentralOAuthService');
const { registerRecruiterDiagnosticRoutes } = require('./recruiter/diagnosticsRoutes');
const { registerRecruiterBitrixMappingRoutes } = require('./recruiter/bitrixMappingRoutes');

/**
 * Recruiter API: who the recruiters are, whose number texts a lead, and how
 * they are doing on the phone.
 *
 *   GET    /                      → list recruiters (masked credentials, never raw)
 *   POST   /                      → create recruiter (Bitrix user id + optional
 *                                   per-number JWT / custom Client ID-Secret)
 *   PUT    /:id                   → update recruiter (blank secrets keep stored values)
 *   DELETE /:id                   → delete recruiter
 *   POST   /connect-link          → mint a "sign in with RingCentral" link so a
 *                                   recruiter can attach their own number
 *   DELETE /:id/ringcentral-login → forget a recruiter's RingCentral login
 *   GET    /bitrix-users          → the Bitrix user directory, for a picker
 *   POST   /bitrix-automap        → match recruiters to Bitrix users (preview,
 *                                   or write with { apply: true })
 *   POST   /sync                  → run a call-log sync now (optional ?full=1)
 *   GET    /stats                 → per-recruiter KPIs vs targets (?date= or ?start=&end=)
 *   GET    /public-stats          → unauthenticated leaderboard stats (today, one
 *                                   day, or a range; never phone numbers/secrets)
 *
 * The live credential checks (/:id/test, /:id/diagnose, /:id/test-sms) live in
 * ./recruiter/diagnosticsRoutes.js, and the Bitrix mapping endpoints in
 * ./recruiter/bitrixMappingRoutes.js.
 */
const PUBLIC_MAX_RANGE_DAYS = 31;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real YYYY-MM-DD calendar date (rejects 2026-02-30 etc.). */
function isValidIsoDate(value) {
  return typeof value === 'string'
    && ISO_DATE_RE.test(value)
    && DateTime.fromISO(value).isValid;
}

/**
 * Interpret ?date= / ?start=&end= query params for a stats window.
 * Returns { mode:'today' } | { mode:'single-day', date } |
 * { mode:'range', start, end } | { error } for a 400 response.
 */
function parseStatsWindow(query = {}, { maxRangeDays = PUBLIC_MAX_RANGE_DAYS } = {}) {
  const { date, start, end } = query;
  if (start !== undefined || end !== undefined) {
    if (!isValidIsoDate(start) || !isValidIsoDate(end)) {
      return { error: 'start and end must both be valid YYYY-MM-DD dates.' };
    }
    const startDt = DateTime.fromISO(start);
    const endDt = DateTime.fromISO(end);
    if (endDt < startDt) return { error: 'end date must not be before start date.' };
    const days = Math.round(endDt.diff(startDt, 'days').days) + 1;
    if (days > maxRangeDays) return { error: `Date range is limited to ${maxRangeDays} days.` };
    if (days === 1) return { mode: 'single-day', date: start };
    return { mode: 'range', start, end };
  }
  if (date !== undefined) {
    if (!isValidIsoDate(date)) return { error: 'date must be a valid YYYY-MM-DD date.' };
    return { mode: 'single-day', date };
  }
  return { mode: 'today', date: null };
}

/**
 * Turn a uniqueness violation into something an operator can act on. Two
 * columns are unique here — the phone number and the Bitrix user — and the
 * fixes differ, so the message names which one collided.
 */
function conflictMessage(err) {
  const text = `${err?.message || ''} ${err?.constraint || ''}`;
  if (err?.code !== '23505' && !/unique/i.test(text)) return null;
  if (/bitrix_user_id/i.test(text)) {
    return 'That Bitrix user is already mapped to another recruiter.';
  }
  return 'That phone number is already assigned to a recruiter.';
}

function createRecruiterRouter({ authMiddleware }) {
  const router = express.Router();

  router.get('/', authMiddleware, async (req, res) => {
    try {
      const recruiters = await rc.listRecruitersForAdmin({ includeInactive: true });
      res.json({ recruiters });
    } catch (err) {
      console.error('[RECRUITER API] list failed:', err.message);
      res.status(500).json({ error: 'Failed to load recruiters' });
    }
  });

  router.post('/', authMiddleware, async (req, res) => {
    try {
      const recruiter = await rc.createRecruiter({
        name: req.body?.name,
        phoneNumber: req.body?.phoneNumber,
        active: req.body?.active,
        jwtToken: req.body?.jwtToken,
        clientId: req.body?.clientId,
        clientSecret: req.body?.clientSecret,
        bitrixUserId: req.body?.bitrixUserId,
      });
      res.json({ recruiter });
    } catch (err) {
      const conflict = conflictMessage(err);
      if (conflict) return res.status(409).json({ error: conflict });
      console.error('[RECRUITER API] create failed:', err.message);
      res.status(400).json({ error: err.message });
    }
  });

  router.put('/:id', authMiddleware, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid id' });
      const recruiter = await rc.updateRecruiter(id, {
        name: req.body?.name,
        phoneNumber: req.body?.phoneNumber,
        active: req.body?.active,
        jwtToken: req.body?.jwtToken,
        clientId: req.body?.clientId,
        clientSecret: req.body?.clientSecret,
        clearJwtToken: req.body?.clearJwtToken,
        clearClientCreds: req.body?.clearClientCreds,
        bitrixUserId: req.body?.bitrixUserId,
      });
      if (!recruiter) return res.status(404).json({ error: 'Recruiter not found' });
      res.json({ recruiter });
    } catch (err) {
      const conflict = conflictMessage(err);
      if (conflict) return res.status(409).json({ error: conflict });
      console.error('[RECRUITER API] update failed:', err.message);
      res.status(400).json({ error: err.message });
    }
  });

  registerRecruiterDiagnosticRoutes(router, { authMiddleware });
  registerRecruiterBitrixMappingRoutes(router, { authMiddleware });

  router.delete('/:id', authMiddleware, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid id' });
      await rc.deleteRecruiter(id);
      res.json({ deleted: true });
    } catch (err) {
      console.error('[RECRUITER API] delete failed:', err.message);
      res.status(500).json({ error: 'Failed to delete recruiter' });
    }
  });

  /**
   * Mint a personal "sign in with RingCentral" link.
   *
   * With `recruiterId` it attaches to that recruiter; without one the link is
   * open and the recruiter row is found by (or created from) the number on the
   * RingCentral extension that signs in — the new-hire path, where nobody has
   * to know the number in advance.
   */
  router.post('/connect-link', authMiddleware, async (req, res) => {
    try {
      const rawId = req.body?.recruiterId;
      const recruiterId = rawId === undefined || rawId === null || rawId === '' ? null : Number(rawId);
      if (recruiterId !== null && (!Number.isInteger(recruiterId) || recruiterId <= 0)) {
        return res.status(400).json({ error: 'Invalid recruiterId' });
      }
      const { connectUrl, expiresAt } = await createRecruiterConnectLink({
        recruiterId,
        invitedName: req.body?.invitedName,
        createdBy: req.admin?.username || null,
      });
      return res.json({ connectUrl, expiresAt });
    } catch (err) {
      console.error('[RECRUITER API] connect link failed:', err.message);
      return res.status(400).json({ error: err.message });
    }
  });

  // Forget a recruiter's RingCentral login (they left, or must re-authorize).
  // Their pasted JWT, if any, is untouched — this clears only the OAuth grant.
  router.delete('/:id/ringcentral-login', authMiddleware, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid id' });
      const recruiter = await rc.clearRecruiterOAuth(id);
      if (!recruiter) return res.status(404).json({ error: 'Recruiter not found' });
      // Revoking the stored login must revoke the in-memory access token too,
      // or their sends keep working for up to an hour after it was removed.
      clearRecruiterTokenCache(id);
      return res.json({ recruiter });
    } catch (err) {
      console.error('[RECRUITER API] clear RingCentral login failed:', err.message);
      return res.status(500).json({ error: 'Failed to clear the RingCentral login' });
    }
  });

  router.post('/sync', authMiddleware, async (req, res) => {
    try {
      const full = req.query.full === '1' || req.body?.full === true;
      const result = await syncNow({ full });
      res.json(result);
    } catch (err) {
      console.error('[RECRUITER API] sync failed:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  router.get('/stats', authMiddleware, async (req, res) => {
    try {
      const parsed = parseStatsWindow(req.query, { maxRangeDays: PUBLIC_MAX_RANGE_DAYS });
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      const cfg = await rc.getRcConfig();
      const stats = parsed.mode === 'range'
        ? await rc.getRecruiterStatsRange(parsed.start, parsed.end, cfg)
        : await rc.getRecruiterStats(parsed.date, cfg);
      res.json(stats);
    } catch (err) {
      console.error('[RECRUITER API] stats failed:', err.message);
      res.status(500).json({ error: 'Failed to load recruiter stats' });
    }
  });

  // Public (unauthenticated) stats for the gamified /recruiters leaderboard
  // the recruiting team keeps open on a screen.
  //   GET /public-stats                       → today (live)
  //   GET /public-stats?date=YYYY-MM-DD       → one historical day
  //   GET /public-stats?start=…&end=…         → inclusive range (max 31 days)
  // Deliberately limited: names + KPI numbers only — no phone numbers, no
  // credentials, no settings.
  router.get('/public-stats', async (req, res) => {
    try {
      const parsed = parseStatsWindow(req.query, { maxRangeDays: PUBLIC_MAX_RANGE_DAYS });
      if (parsed.error) return res.status(400).json({ error: parsed.error });

      const cfg = await rc.getRcConfig();
      const stats = parsed.mode === 'range'
        ? await rc.getRecruiterStatsRange(parsed.start, parsed.end, cfg)
        : await rc.getRecruiterStats(parsed.date, cfg);

      res.json({
        dateMode: stats.dateMode,
        date: stats.date,
        startDate: stats.startDate,
        endDate: stats.endDate,
        rangeDays: stats.rangeDays,
        timezone: stats.timezone,
        targets: stats.targets,
        thresholds: stats.thresholds,
        recruiters: stats.recruiters.map(({ phoneNumber, ...rest }) => rest),
      });
    } catch (err) {
      console.error('[RECRUITER API] public stats failed:', err.message);
      res.status(500).json({ error: 'Failed to load recruiter stats' });
    }
  });

  return router;
}

module.exports = { createRecruiterRouter, parseStatsWindow, PUBLIC_MAX_RANGE_DAYS };
