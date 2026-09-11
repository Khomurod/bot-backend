/**
 * Admin → Settings → Recruiting hours.
 *
 * Two things are configured here and they are deliberately not the same switch:
 * WHEN the recruiting team works, and WHETHER Wenze may answer a candidate when
 * they do not. A company can record its hours — useful on its own, and the
 * screen shows what Wenze would do at each — without yet letting it speak.
 *
 * WHAT THIS SCREEN REFUSES TO SAVE is where the safety lives. A window with an
 * unreadable time, a day outside 1–7, a reply cap above the schema's ceiling —
 * each is rejected with a sentence naming the window, because a malformed row
 * that saved silently would be read by `evaluateHours` as "not a window" and
 * the office would look open forever. That failure is invisible: nothing sends,
 * nothing errors, and a feature an administrator switched on simply never runs.
 */
const express = require('express');

const store = require('../../../database/recruitingHours');
const conversations = require('../../../database/recruitingConversations');
const {
  normaliseWindow, evaluateHours, describeSchedule, timeToMinutes, DAY_NAMES,
} = require('../../../lib/recruiting/workingHours');
const { sendFailure } = require('../../middleware/failureResponse');

/** A validation refusal the screen can point at a field with. */
function refuse(res, message, field = null) {
  return res.status(400).json({ error: message, field });
}

/**
 * Every window, checked. Returns either the cleaned list or the first problem,
 * named by position — "Window 2" is something an operator can find; an index
 * into a JSON array is not.
 */
function validateWindows(raw) {
  if (!Array.isArray(raw)) return { error: 'Working hours must be a list of windows.' };
  if (raw.length > 20) return { error: 'That is more than 20 windows; a schedule that long is a mistake.' };

  const cleaned = [];
  for (let i = 0; i < raw.length; i += 1) {
    const win = raw[i] || {};
    const where = `Window ${i + 1}`;
    if (timeToMinutes(win.start) === null) {
      return { error: `${where}: "${String(win.start ?? '')}" is not a time like 08:00.`, field: `windows.${i}.start` };
    }
    if (timeToMinutes(win.end) === null) {
      return { error: `${where}: "${String(win.end ?? '')}" is not a time like 18:00.`, field: `windows.${i}.end` };
    }
    const days = Array.isArray(win.days) ? win.days.map(Number) : [];
    if (days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
      return {
        error: `${where}: days must be 1 (${DAY_NAMES[1]}) to 7 (${DAY_NAMES[7]}).`,
        field: `windows.${i}.days`,
      };
    }
    const normalised = normaliseWindow({ ...win, days });
    if (!normalised) return { error: `${where} could not be read.`, field: `windows.${i}` };
    cleaned.push({
      label: normalised.label, days: normalised.days,
      start: normalised.start, end: normalised.end,
    });
  }
  return { windows: cleaned };
}

function createRecruitingHoursRouter({ authMiddleware }) {
  const router = express.Router();

  router.get('/recruiting-hours', authMiddleware, async (req, res) => {
    try {
      const settings = await store.getRecruitingHours();
      const now = await evaluateNow(settings);
      const active = await conversations.listConversations({ limit: 25 }).catch(() => []);
      res.json({
        settings,
        // What the schedule MEANS right now, computed server-side so the screen
        // and the feature can never disagree about whether the office is open.
        now,
        summary: describeSchedule({ timezone: settings.timezone, windows: settings.windows }),
        conversations: active,
      });
    } catch (err) {
      sendFailure(res, err, {
        message: 'Failed to load the recruiting hours', logPrefix: '[RECRUITING-HOURS]',
      });
    }
  });

  router.put('/recruiting-hours', authMiddleware, async (req, res) => {
    const patch = req.body || {};
    try {
      if (Object.prototype.hasOwnProperty.call(patch, 'windows')) {
        const verdict = validateWindows(patch.windows);
        if (verdict.error) return refuse(res, verdict.error, verdict.field || null);
        patch.windows = verdict.windows;
      }

      for (const key of ['quietStartLocal', 'quietEndLocal']) {
        if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
        if (timeToMinutes(patch[key]) === null) {
          return refuse(res, `"${String(patch[key] ?? '')}" is not a time like 21:00.`, key);
        }
      }

      if (Object.prototype.hasOwnProperty.call(patch, 'maxRepliesPerConversation')) {
        const cap = Number(patch.maxRepliesPerConversation);
        // Clamped in JS to the same bounds the schema CHECKs, so an out-of-range
        // value is a sentence rather than a 500 from Postgres.
        if (!Number.isInteger(cap) || cap < 0 || cap > 20) {
          return refuse(res, 'The reply limit must be a whole number between 0 and 20.', 'maxRepliesPerConversation');
        }
      }

      if (Object.prototype.hasOwnProperty.call(patch, 'aiAfterHoursEnabled') && patch.aiAfterHoursEnabled === true) {
        // Switching it on with no hours would mean "the office is always open",
        // so the feature would be on and permanently silent. Refusing says so.
        const current = await store.getRecruitingHours();
        const windows = patch.windows ?? current.windows;
        if (!Array.isArray(windows) || !windows.length) {
          return refuse(
            res,
            'Add at least one working-hours window first — with none, Wenze treats the office '
            + 'as always open and would never answer anybody.',
            'windows',
          );
        }
      }

      const settings = await store.updateRecruitingHours(patch, {
        updatedBy: req.admin?.username || null,
      });
      return res.json({ settings, now: await evaluateNow(settings) });
    } catch (err) {
      return sendFailure(res, err, {
        message: 'Failed to save the recruiting hours', logPrefix: '[RECRUITING-HOURS]',
      });
    }
  });

  /**
   * Hand a conversation back, or let Wenze resume one.
   *
   * A recruiter who has answered a candidate themselves may want Wenze to stop;
   * an administrator who cleared up why a reply was refused may want it to
   * carry on. Both are one PATCH, both are audited by the status and reason
   * that end up on the row.
   */
  router.patch('/recruiting-hours/conversations/:phone', authMiddleware, async (req, res) => {
    try {
      const status = String(req.body?.status || '').trim();
      if (!['active', 'handed_off', 'stopped'].includes(status)) {
        return refuse(res, 'Status must be active, handed_off or stopped.', 'status');
      }
      const row = await conversations.closeConversation(req.params.phone, {
        status,
        reason: status === 'active'
          ? null
          : String(req.body?.reason || `set by ${req.admin?.username || 'an administrator'}`),
      });
      if (!row) return res.status(404).json({ error: 'No conversation for that number.' });
      return res.json({ conversation: row });
    } catch (err) {
      return sendFailure(res, err, {
        message: 'Failed to update the conversation', logPrefix: '[RECRUITING-HOURS]',
      });
    }
  });

  return router;
}

/** Open or closed right now, and when it changes — the screen's live answer. */
async function evaluateNow(settings) {
  const verdict = evaluateHours(
    { timezone: settings.timezone, windows: settings.windows },
    new Date().toISOString(),
  );
  return {
    open: verdict.open,
    reason: verdict.reason,
    localTime: verdict.localTime,
    nextOpenIso: verdict.nextOpenIso,
    // The honest answer to "would Wenze answer a candidate this minute", which
    // is a different question from whether the office is shut.
    aiWouldAnswer: verdict.open === false && settings.aiAfterHoursEnabled === true,
  };
}

module.exports = { createRecruitingHoursRouter, validateWindows, evaluateNow };
