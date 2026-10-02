/**
 * The Yes / No / Later buttons under a question. PURE.
 *
 * WHY BUTTONS AT ALL. Production, 2026-10-02: fifteen questions asked, none
 * answered. Every one of them said "Reply to this message: yes · no · later" —
 * which means long-pressing a message, choosing Reply, and typing. On a phone,
 * between two other things, that is three steps more than anybody takes. A
 * button is one.
 *
 * A TAP IS THE SAME AS TYPING THE WORD. `wordFor` turns a button back into the
 * word it stands for, and the reply path reads that word through the same
 * deterministic parser a typed answer goes through. There is no second set of
 * rules for buttons, so a button can never do something the word would not.
 *
 * WHAT A BUTTON CARRIES: the notice id and one letter. Never an action key,
 * never a finding id, never anything a person could edit into another
 * operation — and the handler still refuses a tap whose notice id is not the
 * notice the button is actually attached to.
 */

/** Telegram limits callback data to 64 bytes; this stays far below it. */
const PREFIX = 'ctl';
const CODES = Object.freeze({ approve: 'a', dismiss: 'd', snooze: 's' });
const BY_CODE = Object.freeze({ a: 'approve', d: 'dismiss', s: 'snooze' });

/** What the button says. The word a typed reply would use is what it means. */
const BUTTON_TEXT = Object.freeze({
  approve: '✅ Yes',
  dismiss: '❌ No',
  snooze: '⏰ Later',
});

/** The typed word each button stands for — read by `lib/control/intent.js`. */
const WORD = Object.freeze({ approve: 'yes', dismiss: 'no', snooze: 'later' });

const PATTERN = /^ctl:(\d{1,12}):([ads])$/;

/**
 * The inline keyboard for one question, or null when there is nothing to tap.
 *
 * Only offered actions get a button, in the order they were offered. A
 * question without `approve` (nothing to apply) shows No and Later only.
 */
function keyboardFor(noticeId, offered) {
  const id = Number(noticeId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const row = (Array.isArray(offered) ? offered : [])
    .map((o) => o && o.key)
    .filter((key) => CODES[key])
    .map((key) => ({ text: BUTTON_TEXT[key], callback_data: `${PREFIX}:${id}:${CODES[key]}` }));
  if (row.length === 0) return null;
  return { inline_keyboard: [row] };
}

/**
 * Read a tap. Returns null for anything that is not one of ours, so the
 * caller can let every other button in the bot through untouched.
 */
function parseButton(data) {
  const m = PATTERN.exec(String(data || ''));
  if (!m) return null;
  const noticeId = Number(m[1]);
  if (!Number.isSafeInteger(noticeId) || noticeId <= 0) return null;
  return { noticeId, action: BY_CODE[m[2]] };
}

function wordFor(action) {
  return WORD[action] || null;
}

module.exports = {
  PREFIX, BUTTON_TEXT, PATTERN, keyboardFor, parseButton, wordFor,
};
