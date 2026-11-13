'use strict';

/**
 * When Bitrix keeps saying no, the owner is told — once (owner, 14 November
 * 2026, decision d). PURE. docs/architecture/activity-log.md.
 *
 * THE RULE. The newest entries of ONE feature (`trigger`), newest first: a
 * run of `failed` / `refused` with no `done` / `already_done` in between is a
 * streak. At `STREAK_THRESHOLD` (3) the owner gets ONE notice. Not again for
 * that streak — the notice key carries the id of the streak's first entry, so
 * the outbox's UNIQUE key says it once whatever this decides — and never more
 * than one a `QUIET_HOURS` (6) for the same feature, so a feature that fails,
 * succeeds once and fails again all day is one notice every six hours at most.
 * A success ends the streak; the next three failures are a new one.
 *
 * A streak whose START is not in the window read (every entry read failed)
 * began long before this one and was already decided on when it crossed the
 * threshold — so nothing is sent for it: a new id would otherwise make a new
 * notice key for the same streak.
 */

const STREAK_THRESHOLD = 3;
const QUIET_HOURS = 6;
/** Entries read per decision — the streak's start must be among them. */
const WINDOW = 20;

const BAD = new Set(['failed', 'refused']);

/** What the feature is called in a notice. An unknown trigger is shown as itself. */
const TRIGGER_LABELS = Object.freeze({
  'board_bitrix.button': 'Board ↔ Bitrix: a button under a question',
  'board_bitrix.reply': 'Board ↔ Bitrix: a reply to a question',
  'board_bitrix.sync': 'Board ↔ Bitrix: the automatic status sync',
  'hiring_stage.move': 'Hiring: Move to a stage',
  'hiring_stage.create': 'Hiring: creating a candidate\'s contact and deal',
  'hiring_stage.rename': 'Hiring: Rename a "No name" deal',
  'home_time.violation_card': 'Home time: moving a pipeline-33 violation card',
  'facebook_lead.create': 'Facebook leads: creating the lead in Bitrix',
});

function triggerLabel(trigger) {
  return TRIGGER_LABELS[trigger] || String(trigger || 'an unnamed feature');
}

/**
 * @param {Array<{id: number, result: string}>} entries  newest first, one feature's
 * @returns {{length: number, startId: number|null, complete: boolean}}
 *   `complete`: the streak's first entry is in `entries` (a success, or the
 *   oldest entry there is, lies beyond it)
 */
function currentStreak(entries, { window = WINDOW } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  let n = 0;
  while (n < list.length && BAD.has(list[n]?.result)) n += 1;
  const reachedEnd = n === list.length;
  return {
    length: n,
    startId: n ? Number(list[n - 1].id) : null,
    complete: !reachedEnd || list.length < window,
  };
}

/**
 * @param {object} args
 * @param {object[]} args.entries          newest first, at most `window` of one feature
 * @param {boolean} args.toldWithinQuietHours  a notice for this feature went out (or is
 *   waiting) in the last QUIET_HOURS
 * @returns {{notify: boolean, streak: number, streakStartId: number|null, why: string}}
 */
function decideFailureNotice({
  entries, toldWithinQuietHours = false, threshold = STREAK_THRESHOLD, window = WINDOW,
}) {
  const streak = currentStreak(entries, { window });
  const base = { streak: streak.length, streakStartId: streak.startId };
  if (streak.length < threshold) return { ...base, notify: false, why: 'not enough failures in a row' };
  if (!streak.complete) return { ...base, notify: false, why: 'this streak began before the entries read — already decided' };
  if (toldWithinQuietHours) return { ...base, notify: false, why: `already told within ${QUIET_HOURS} hours` };
  return { ...base, notify: true, why: `${streak.length} in a row` };
}

/**
 * The notice's words: plain, no code, no id that looks like a token, no name.
 * @param {{trigger: string, streak: number, latest: {result: string, error?: string, reason?: string}}} args
 */
function failureNoticeText({ trigger, streak, latest }) {
  const said = latest?.result === 'refused' ? 'Bitrix (or a safety check) said no' : 'Bitrix did not answer or failed';
  const detail = String(latest?.error || latest?.reason || '').trim();
  return {
    title: `Bitrix: ${streak} changes in a row did not go through`,
    lines: [
      `Where: ${triggerLabel(trigger)}`,
      `Latest: ${said}${detail ? ` — ${detail.slice(0, 160)}` : ''}`,
    ],
    action: 'See each attempt in the admin panel: Monitoring → Logs. You will not be told again until one goes through (at most once every 6 hours).',
  };
}

module.exports = {
  STREAK_THRESHOLD,
  QUIET_HOURS,
  WINDOW,
  TRIGGER_LABELS,
  triggerLabel,
  currentStreak,
  decideFailureNotice,
  failureNoticeText,
};
