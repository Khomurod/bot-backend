/**
 * 75¢/mile Driver Raise Approval — HTTP routes.
 *
 * Exports two routers:
 *  - publicRouter  (mounted at /api/raise, NO auth): the dispatcher-facing
 *    temporary-link flow (round info, request/verify OTP, submit).
 *  - adminRouter   (mounted at /api/raise/admin, JWT auth): team management,
 *    settings, send-now, round results.
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../../config/config');
const ra = require('../../database/raiseApproval');
const raise = require('../../services/raiseApprovalService');

const publicRouter = express.Router();
const adminRouter = express.Router();

function adminAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    req.admin = jwt.verify(authHeader.slice(7), config.jwtSecret, { algorithms: ['HS256'] });
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function sendServiceError(res, err, fallback = 'Request failed') {
  const status = err.status || 500;
  if (status >= 500) console.error('[RAISE API]', err.message);
  return res.status(status).json({ error: err.message || fallback });
}

// ─────────────────────────── Public (dispatcher) ───────────────────────────

publicRouter.get('/:token', async (req, res) => {
  try {
    res.json(await raise.getPublicRoundInfo(req.params.token));
  } catch (err) {
    sendServiceError(res, err, 'Could not load this review.');
  }
});

publicRouter.post('/:token/request-otp', async (req, res) => {
  try {
    const result = await raise.requestOtp({
      token: req.params.token,
      teamId: Number.parseInt(req.body?.teamId, 10),
      contact: req.body?.contact,
    });
    res.json(result);
  } catch (err) {
    sendServiceError(res, err, 'Could not send the code.');
  }
});

publicRouter.post('/:token/verify-otp', async (req, res) => {
  try {
    const teamId = Number.parseInt(req.body?.teamId, 10);
    await raise.verifyOtp({ token: req.params.token, contact: req.body?.contact }, req.body?.code);
    const drivers = await raise.getTeamDriversForRound(req.params.token, teamId);
    res.json({ verified: true, drivers });
  } catch (err) {
    sendServiceError(res, err, 'Could not verify the code.');
  }
});

publicRouter.post('/:token/submit', async (req, res) => {
  try {
    const result = await raise.submitResponse({
      token: req.params.token,
      teamId: Number.parseInt(req.body?.teamId, 10),
      dispatcherName: req.body?.name,
      contact: req.body?.contact,
      picks: req.body?.picks,
    });
    res.json(result);
  } catch (err) {
    sendServiceError(res, err, 'Could not submit your response.');
  }
});

// ─────────────────────────────── Admin ─────────────────────────────────────

adminRouter.use(adminAuth);

adminRouter.get('/settings', async (req, res) => {
  try {
    const settings = await ra.getRaiseSettings();
    res.json({ settings, scheduleDescription: raise.describeSchedule(settings) });
  } catch (err) {
    sendServiceError(res, err, 'Failed to load settings.');
  }
});

adminRouter.put('/settings', async (req, res) => {
  try {
    const b = req.body || {};
    const patch = {};
    if (b.enabled !== undefined) patch.enabled = Boolean(b.enabled);
    if (b.otp_channel !== undefined) {
      if (!['gmail', 'ringcentral'].includes(b.otp_channel)) {
        return res.status(400).json({ error: 'Invalid otp_channel' });
      }
      patch.otp_channel = b.otp_channel;
    }
    if (b.schedule_enabled !== undefined) patch.schedule_enabled = Boolean(b.schedule_enabled);
    if (b.weekly_day_of_week !== undefined) {
      const d = Number.parseInt(b.weekly_day_of_week, 10);
      if (!(d >= 1 && d <= 7)) return res.status(400).json({ error: 'weekly_day_of_week must be 1-7' });
      patch.weekly_day_of_week = d;
    }
    if (b.weekly_time_local !== undefined) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(b.weekly_time_local))) {
        return res.status(400).json({ error: 'weekly_time_local must be HH:MM' });
      }
      patch.weekly_time_local = b.weekly_time_local;
    }
    if (b.schedule_timezone !== undefined) patch.schedule_timezone = String(b.schedule_timezone);
    if (b.rate_low !== undefined) patch.rate_low = Number(b.rate_low);
    if (b.rate_high !== undefined) patch.rate_high = Number(b.rate_high);
    if (b.link_ttl_hours !== undefined) {
      const h = Number.parseInt(b.link_ttl_hours, 10);
      if (!(h >= 1 && h <= 720)) return res.status(400).json({ error: 'link_ttl_hours must be 1-720' });
      patch.link_ttl_hours = h;
    }
    let settings = await ra.updateRaiseSettings(patch);
    // Re-arm the schedule when timing changed or it was just enabled.
    if (settings.schedule_enabled) settings = await raise.recomputeNextRun(settings).then(() => ra.getRaiseSettings());
    res.json({ settings, scheduleDescription: raise.describeSchedule(settings) });
  } catch (err) {
    sendServiceError(res, err, 'Failed to save settings.');
  }
});

adminRouter.get('/company-drivers', async (req, res) => {
  try {
    res.json({ drivers: await raise.fetchCompanyDriverCandidates() });
  } catch (err) {
    sendServiceError(res, err, 'Failed to load company drivers.');
  }
});

adminRouter.get('/teams', async (req, res) => {
  try {
    res.json({ teams: await ra.listDispatchTeams({ includeInactive: true }) });
  } catch (err) {
    sendServiceError(res, err, 'Failed to load teams.');
  }
});

adminRouter.post('/teams', async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Team name is required' });
    res.status(201).json({ team: await ra.createDispatchTeam(name) });
  } catch (err) {
    sendServiceError(res, err, 'Failed to create team.');
  }
});

adminRouter.patch('/teams/:id', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const patch = {};
    if (req.body?.name !== undefined) patch.name = String(req.body.name).trim();
    if (req.body?.active !== undefined) patch.active = Boolean(req.body.active);
    const team = await ra.updateDispatchTeam(id, patch);
    if (!team) return res.status(404).json({ error: 'Team not found' });
    res.json({ team });
  } catch (err) {
    sendServiceError(res, err, 'Failed to update team.');
  }
});

adminRouter.delete('/teams/:id', async (req, res) => {
  try {
    const ok = await ra.deleteDispatchTeam(Number.parseInt(req.params.id, 10));
    if (!ok) return res.status(404).json({ error: 'Team not found' });
    res.json({ success: true });
  } catch (err) {
    sendServiceError(res, err, 'Failed to delete team.');
  }
});

adminRouter.get('/teams/:id/drivers', async (req, res) => {
  try {
    res.json({ drivers: await ra.listTeamDrivers(Number.parseInt(req.params.id, 10)) });
  } catch (err) {
    sendServiceError(res, err, 'Failed to load team drivers.');
  }
});

adminRouter.put('/teams/:id/drivers', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const incoming = Array.isArray(req.body?.drivers) ? req.body.drivers : [];
    const drivers = incoming
      .filter((d) => d && d.driver_normalized_name && d.driver_name)
      .map((d) => ({
        driver_external_id: d.driver_external_id || null,
        driver_normalized_name: String(d.driver_normalized_name),
        driver_name: String(d.driver_name),
      }));
    res.json({ drivers: await ra.setTeamDrivers(id, drivers) });
  } catch (err) {
    sendServiceError(res, err, 'Failed to save team drivers.');
  }
});

adminRouter.post('/send-now', async (req, res) => {
  try {
    const periodStart = req.body?.periodStart || null;
    const periodEnd = req.body?.periodEnd || null;
    if ((periodStart && !periodEnd) || (!periodStart && periodEnd)) {
      return res.status(400).json({ error: 'Provide both period start and end (or neither).' });
    }
    const { round, link } = await raise.sendNow({
      periodStart, periodEnd, requestedBy: req.admin?.username || 'admin',
    });
    res.status(201).json({ round, link });
  } catch (err) {
    sendServiceError(res, err, 'Failed to send the review.');
  }
});

adminRouter.get('/rounds', async (req, res) => {
  try {
    res.json({ rounds: await ra.listRounds({ limit: 50 }) });
  } catch (err) {
    sendServiceError(res, err, 'Failed to load rounds.');
  }
});

adminRouter.get('/rounds/:id/results', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const round = await ra.getRoundById(id);
    if (!round) return res.status(404).json({ error: 'Round not found' });
    res.json({ round, submissions: await ra.getRoundResults(id) });
  } catch (err) {
    sendServiceError(res, err, 'Failed to load results.');
  }
});

adminRouter.post('/rounds/:id/close', async (req, res) => {
  try {
    const round = await ra.closeRound(Number.parseInt(req.params.id, 10));
    if (!round) return res.status(404).json({ error: 'Round not found' });
    res.json({ round });
  } catch (err) {
    sendServiceError(res, err, 'Failed to close round.');
  }
});

module.exports = { publicRouter, adminRouter };
