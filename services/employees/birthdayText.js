'use strict';

/**
 * The words on an employee birthday post. Pure.
 *
 * THE CAPTION IS FIXED. The owner's own text (23 October 2026), word for word,
 * every time — never written or varied by a model:
 *
 *   Dear @tag,
 *
 *   Wishing you all the best that life has to offer.
 *   Together, we grow stronger and achieve more!
 *
 * The tag is the employee's Telegram account: `@username` when they have one,
 * else an inline mention by numeric id, else their name as plain text (no
 * ping, but never broken markup).
 *
 * THE CARD shows the FULL first name from the staff list ("Testbek", never a
 * short form) and the American name under it. The list is kept in capitals;
 * the card is not.
 *
 * See docs/architecture/employee-birthday-cards.md.
 */
const { buildMention } = require('../telegramMention');

const WISH_LINES = [
  'Wishing you all the best that life has to offer.',
  'Together, we grow stronger and achieve more!',
];

/** "O'RTOQBOY" → "O'rtoqboy", "MUHAMMAD ALI" → "Muhammad Ali", "gʻanisher" → "Gʻanisher". */
function titleCaseName(raw) {
  const text = String(raw == null ? '' : raw).trim().replace(/\s+/g, ' ');
  if (!text) return '';
  return text
    .split(/([ -])/)
    .map((part) => {
      if (part === ' ' || part === '-' || !part) return part;
      // Only the first letter is raised, so a letter after an apostrophe stays
      // lower-case: O'rtoqboy, not O'Rtoqboy.
      const lower = part.toLocaleLowerCase('en-US');
      return lower.charAt(0).toLocaleUpperCase('en-US') + lower.slice(1);
    })
    .join('');
}

/** The full first name, as the card prints it. */
function cardFirstName(employee) {
  return titleCaseName(employee?.first_name);
}

/** The American name as typed, or '' when there is none. */
function cardAmericanName(employee) {
  return String(employee?.american_name || '').trim().replace(/\s+/g, ' ');
}

/** One or two capitals for the photo frame when there is no photo yet. */
function initials(employee) {
  const first = cardFirstName(employee).charAt(0);
  const last = titleCaseName(employee?.last_name).charAt(0);
  return `${first}${last}`.trim() || '?';
}

/** The fixed caption, with the employee tagged. Telegram HTML. */
function birthdayCaption(employee) {
  const tag = buildMention(
    { username: employee?.telegram_username, telegram_user_id: employee?.telegram_user_id },
    { fallbackName: cardAmericanName(employee) || cardFirstName(employee) || 'friend' }
  );
  return `Dear ${tag},\n\n${WISH_LINES.join('\n')}`;
}

module.exports = {
  WISH_LINES,
  titleCaseName,
  cardFirstName,
  cardAmericanName,
  initials,
  birthdayCaption,
};
