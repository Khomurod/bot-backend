/**
 * The morning summary: one message a day instead of a scattering. PURE.
 *
 * WHY. Production, 2026-10-02: fifteen questions asked, none answered, and
 * nothing anywhere said so. A question that is not answered within the day
 * slides up the chat under everything that arrived after it and is, in
 * practice, gone. The summary brings back what is still waiting — the
 * escalation — and says in the same breath what Wenze did on its own and
 * whether anything is broken, so one glance a day is enough to know the
 * state of things.
 *
 * WHAT IT MAY SAY: counts, the finding titles a question already showed, and
 * the plain labels of workers that need a look. Never an id, a chat, an action
 * key or a person's phone — the same rules as every other notice
 * (`docs/architecture/operational-notifications.md`).
 */
const { DateTime } = require('luxon');

const ZONE = 'America/Chicago';
/** Sent from 08:00 local. */
const FROM_HOUR = 8;
/**
 * …and not after 20:00. A process that was down all day must not post the
 * morning summary at midnight; the next morning's is the one worth reading.
 */
const UNTIL_HOUR = 20;
/** How many waiting questions are named. The count always covers them all. */
const MAX_WAITING_NAMED = 3;
const MAX_SYSTEMS_NAMED = 3;

function local(at) {
  if (at instanceof Date) return DateTime.fromJSDate(at).setZone(ZONE);
  if (at) return DateTime.fromISO(String(at), { setZone: true }).setZone(ZONE);
  return DateTime.now().setZone(ZONE);
}

/**
 * Which day's summary is due at `now`, or null when none is.
 *
 * The local date IS the dedup key: the notice outbox refuses a second notice
 * with the same key, so however many times this is asked during the window —
 * every fifteen minutes, across restarts — one summary goes out per day.
 */
function digestDayFor(now = null) {
  const t = local(now);
  if (!t.isValid) return null;
  if (t.hour < FROM_HOUR || t.hour >= UNTIL_HOUR) return null;
  return t.toISODate();
}

/** "today", "yesterday", "3 days ago" — from local calendar days. */
function ageOf(askedAt, now) {
  const asked = local(askedAt);
  const today = local(now);
  if (!asked.isValid || !today.isValid) return null;
  const days = Math.round(today.startOf('day').diff(asked.startOf('day'), 'days').days);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

/** "a, b, c and 2 more" — the first few by name, the rest counted. */
function nameSome(labels) {
  const named = labels.slice(0, MAX_SYSTEMS_NAMED).join(', ');
  return labels.length > MAX_SYSTEMS_NAMED ? `${named} and ${labels.length - MAX_SYSTEMS_NAMED} more` : named;
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Build the summary.
 *
 * EVERY INPUT MAY BE NULL, and null means "could not be read" — never zero.
 * "No questions waiting" said because the read failed would be the reassuring
 * lie this application keeps being built to remove, so an unreadable part is
 * named in one closing line instead of being reported as empty.
 *
 * @param {object} input
 * @param {{title:string|null, askedAt:string}[]|null} input.waiting  unanswered
 *   questions, OLDEST FIRST — the one that has waited longest is named first
 * @param {number|null} input.waitingTotal   how many are waiting in all
 * @param {{bySystem:number, revertedBySystem:number}|null} input.changes  the last day
 * @param {{serious:number, warning:number}|null} input.findings   open now
 * @param {string[]|null} input.systemsDown  plain labels of what is broken
 * @param {string[]|null} [input.systemsWaiting]  switched off / waiting on a
 *   setting — counted apart from broken, never as running
 * @param {Date|string} [input.now]
 * @returns {{title:string, lines:string[]}}
 */
function composeDigest({
  waiting = null, waitingTotal = null, changes = null, findings = null,
  systemsDown = null, systemsWaiting = null, now = null,
} = {}) {
  const lines = [];
  const unread = [];

  if (Array.isArray(waiting) && Number.isFinite(waitingTotal)) {
    if (waitingTotal > 0) {
      lines.push(`Waiting for your answer: ${waitingTotal}`);
      for (const q of waiting.slice(0, MAX_WAITING_NAMED)) {
        const age = ageOf(q.askedAt, now);
        lines.push(`• ${q.title || 'A question'}${age ? ` — asked ${age}` : ''}`);
      }
      if (waitingTotal > MAX_WAITING_NAMED) {
        lines.push(`…and ${waitingTotal - MAX_WAITING_NAMED} more on Needs Attention.`);
      }
    } else {
      lines.push('No questions waiting for you.');
    }
  } else {
    unread.push('the questions');
  }

  if (changes) {
    const done = Number(changes.bySystem) || 0;
    // ONLY WENZE'S OWN CHANGES THAT WERE UNDONE. The plain `reverted` total
    // counts a person's reverted corrections too, which made "1 change
    // (1 undone)" out of one live automatic change and one undone admin edit.
    const undone = Number(changes.revertedBySystem) || 0;
    lines.push(done > 0
      ? `Done on my own in the last day: ${plural(done, 'change', 'changes')}${undone ? ` (${undone} undone)` : ''}.`
      : 'Nothing changed on its own in the last day.');
  } else {
    unread.push('the changes');
  }

  if (findings) {
    const serious = Number(findings.serious) || 0;
    const warning = Number(findings.warning) || 0;
    lines.push(serious + warning > 0
      ? `Open problems: ${serious} serious · ${plural(warning, 'warning', 'warnings')}.`
      : 'No open problems.');
  } else {
    unread.push('the open problems');
  }

  if (Array.isArray(systemsDown)) {
    // SWITCHED OFF OR WAITING ON A SETTING is neither broken nor running.
    // `summariseHealthStates` keeps those out of `down` on purpose, so an empty
    // `down` alone is not "all systems running".
    const waitingOn = Array.isArray(systemsWaiting) ? systemsWaiting : [];
    if (systemsDown.length) lines.push(`Needs a look: ${nameSome(systemsDown)}.`);
    if (waitingOn.length) {
      lines.push(`${systemsDown.length ? '' : 'Nothing is broken. '}Waiting on a setting: ${nameSome(waitingOn)}.`);
    }
    if (!systemsDown.length && !waitingOn.length) lines.push('All systems running.');
  } else {
    unread.push('system health');
  }

  if (unread.length) lines.push(`Could not read ${unread.join(', ')} this morning.`);
  return { title: 'Daily summary', lines };
}

module.exports = {
  ZONE, FROM_HOUR, UNTIL_HOUR, MAX_WAITING_NAMED,
  digestDayFor, ageOf, composeDigest,
};
