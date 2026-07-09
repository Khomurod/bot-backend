const express = require('express');
const { DateTime } = require('luxon');
const rc = require('../../database/ringcentral');
const { syncNow } = require('../../services/recruiterCallSyncService');
const {
  getAccessToken,
  getExtensionInfo,
  fetchExtensionCallLog,
} = require('../../services/ringCentralCallService');

/**
 * Recruiter call-KPI API.
 *   GET    /              → list recruiters (masked credentials, never raw)
 *   POST   /              → create recruiter (per-number JWT + optional custom
 *                           Client ID/Secret; shared pair used otherwise)
 *   PUT    /:id           → update recruiter (blank secrets keep stored values)
 *   DELETE /:id           → delete recruiter
 *   POST   /:id/test      → quick live check: auth + read own call log
 *   POST   /:id/diagnose  → stepwise diagnostic (creds → auth → extension
 *                           identity/number match → call-log read → today count)
 *   POST   /sync          → run a call-log sync now (optional ?full=1)
 *   GET    /stats         → per-recruiter KPIs vs targets (?date= or ?start=&end=)
 *   GET    /public-stats  → unauthenticated leaderboard stats (today, one day,
 *                           or a range; never exposes phone numbers/secrets)
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
      });
      res.json({ recruiter });
    } catch (err) {
      if (/unique/i.test(err.message) || err.code === '23505') {
        return res.status(409).json({ error: 'That phone number is already assigned to a recruiter.' });
      }
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
      });
      if (!recruiter) return res.status(404).json({ error: 'Recruiter not found' });
      res.json({ recruiter });
    } catch (err) {
      if (/unique/i.test(err.message) || err.code === '23505') {
        return res.status(409).json({ error: 'That phone number is already assigned to a recruiter.' });
      }
      console.error('[RECRUITER API] update failed:', err.message);
      res.status(400).json({ error: err.message });
    }
  });

  /**
   * Resolve the effective auth for a recruiter, letting the request body
   * override any piece so credentials can be tested BEFORE saving.
   */
  async function resolveTestAuth(req) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return { error: 'Invalid id' };
    const recruiter = await rc.getRecruiterById(id);
    if (!recruiter) return { error: 'Recruiter not found', status: 404 };
    const cfg = await rc.getRcConfig();
    const stored = rc.resolveRecruiterRcAuth(recruiter, cfg);
    const auth = {
      apiBase: stored.apiBase,
      clientId: String(req.body?.clientId || '').trim() || stored.clientId,
      clientSecret: String(req.body?.clientSecret || '').trim() || stored.clientSecret,
      jwtToken: String(req.body?.jwtToken || '').trim() || stored.jwtToken,
      usesCustomClient: stored.usesCustomClient,
    };
    return { recruiter, cfg, auth };
  }

  // Quick per-number connectivity check: auth + read the JWT user's own log.
  router.post('/:id/test', authMiddleware, async (req, res) => {
    try {
      const { error, status, recruiter, auth } = await resolveTestAuth(req);
      if (error) return res.status(status || 400).json({ error });
      if (!auth.jwtToken) {
        return res.json({ connected: false, message: `No JWT token stored for ${recruiter.name}'s number.` });
      }
      if (!auth.clientId || !auth.clientSecret) {
        return res.json({ connected: false, message: 'Client ID/Secret missing (set the shared pair in Settings or a custom pair on this number).' });
      }
      const now = DateTime.now();
      const records = await fetchExtensionCallLog({
        cfg: auth,
        dateFrom: now.startOf('day').toUTC().toISO(),
        dateTo: now.toUTC().toISO(),
      });
      return res.json({
        connected: true,
        message: `Authenticated. ${records.length} call(s) today on this number's extension.`,
      });
    } catch (err) {
      console.error('[RECRUITER API] test failed:', err.message);
      return res.json({ connected: false, message: err.message });
    }
  });

  // Stepwise diagnostic for one number, for the admin "Diagnose" button.
  router.post('/:id/diagnose', authMiddleware, async (req, res) => {
    const steps = [];
    const step = (label, ok, detail) => { steps.push({ label, ok, detail: detail || '' }); return ok; };
    try {
      const { error, status, recruiter, auth } = await resolveTestAuth(req);
      if (error) return res.status(status || 400).json({ error });

      // 1. Credentials present
      const jwtOk = step('JWT token', Boolean(auth.jwtToken),
        auth.jwtToken ? 'Stored for this number.' : 'Missing — enter a JWT token for this number.');
      const clientOk = step(
        `Client ID/Secret (${auth.usesCustomClient ? 'custom for this number' : 'shared from Settings'})`,
        Boolean(auth.clientId && auth.clientSecret),
        auth.clientId && auth.clientSecret
          ? 'Resolved.'
          : 'Missing — set the shared pair in Settings → RingCentral or a custom pair on this number.'
      );
      if (!jwtOk || !clientOk) return res.json({ ok: false, steps });

      // 2. Authenticate
      try {
        await getAccessToken(auth);
        step('Authentication', true, 'JWT exchanged for an access token.');
      } catch (err) {
        step('Authentication', false, err.message);
        return res.json({ ok: false, steps });
      }

      // 3. Extension identity + number match
      let ext = null;
      try {
        ext = await getExtensionInfo(auth);
        const who = [ext.name, ext.extensionNumber ? `ext. ${ext.extensionNumber}` : null]
          .filter(Boolean).join(', ');
        step('Extension identity', true, who || 'Resolved.');
        const wanted = rc.normalizePhone(recruiter.phone_number);
        const extNumbers = (ext.phoneNumbers || []).map(rc.normalizePhone);
        if (!extNumbers.length) {
          step('Number match', true, 'Extension phone numbers not readable (permission not granted) — skipped.');
        } else if (extNumbers.includes(wanted)) {
          step('Number match', true, `${recruiter.phone_number} belongs to this JWT's extension.`);
        } else {
          step('Number match', false,
            `This JWT's extension owns ${ext.phoneNumbers.join(', ')} — not ${recruiter.phone_number}. Calls will be attributed to the wrong person.`);
        }
      } catch (err) {
        step('Extension identity', false, err.message);
      }

      // 4. Call-log read + today's count
      try {
        const now = DateTime.now();
        const records = await fetchExtensionCallLog({
          cfg: auth,
          dateFrom: now.startOf('day').toUTC().toISO(),
          dateTo: now.toUTC().toISO(),
        });
        const outbound = records.filter((r) => r.direction === 'Outbound').length;
        step('Call log read', true, `${records.length} call(s) today (${outbound} outbound).`);
      } catch (err) {
        step('Call log read', false, err.message);
      }

      const ok = steps.every((s) => s.ok);
      return res.json({ ok, steps });
    } catch (err) {
      console.error('[RECRUITER API] diagnose failed:', err.message);
      step('Diagnostic', false, err.message);
      return res.json({ ok: false, steps });
    }
  });

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
