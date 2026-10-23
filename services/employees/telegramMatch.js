'use strict';

/**
 * Which Telegram account is which employee — a SUGGESTION, never a decision.
 * Pure: the caller hands in the employees and the Telegram accounts the bot
 * has seen (bot_users + group_members).
 *
 * The owner, 23 October 2026: "try to guess them from the Telegram users we
 * already have; the ones you can't guess, or get wrong, I will fill in". So a
 * match is stored as `telegram_match = 'suggested'`, shown as such in the
 * admin, and never overwrites an account a person typed or confirmed.
 *
 * THE RULES, deliberately strict — no suggestion is better than a wrong one:
 *
 *   - NEVER ON A USERNAME. A username can be changed and re-claimed by a
 *     stranger (docs/architecture/telegram-identity.md). Only the Telegram
 *     DISPLAY name is compared; the username is what gets tagged once a match
 *     is found.
 *   - The display name is split at "|" and "/" ("Ozod | Oscar Example",
 *     "Tess Example| Dispatch") and job words are dropped ("Dispatch", "Update",
 *     "Fleet Manager"), so each part is a name someone goes by.
 *   - STRONG: a two-word American name, every word present in one part
 *     ("Sam Example", "Tess Example | Dispatch").
 *   - WEAK: a one-word American name, or the Uzbek first name, as the FIRST
 *     word of a part ("Quinn | Update", "Ozod | Oscar Example").
 *   - An employee gets a suggestion only when exactly ONE account matches at
 *     their best level, and an account is suggested only when exactly ONE
 *     employee picked it. Two employees called Quinn, or two accounts named
 *     Quinn, suggest nothing.
 */

const JOB_WORDS = new Set([
  'acc', 'accountant', 'accounting', 'admin', 'and', 'ap', 'ar', 'dep', 'department',
  'disp', 'dispatch', 'dispatcher', 'driver', 'eld', 'fin', 'finance', 'fleet', 'head',
  'hr', 'lead', 'management', 'manager', 'of', 'payroll', 'recruiter', 'recruitment',
  'relations', 'risk', 'safety', 'senior', 'specialist', 'supervisor', 'team', 'trailer',
  'trainer', 'update', 'wenze',
]);

/** Lower-case words, apostrophes dropped (O'Neal → oneal), anything else a separator. */
function nameWords(text) {
  return String(text == null ? '' : text)
    .toLocaleLowerCase('en-US')
    .replace(/['’‘ʻʼ`]/g, '')
    .split(/[^\p{L}]+/u)
    .filter(Boolean);
}

/** The names an account goes by: its display name split at "|" and "/", job words dropped. */
function accountNameParts(account) {
  const display = [account?.first_name, account?.last_name].filter(Boolean).join(' ');
  return display
    .split(/[|/]/)
    .map((part) => nameWords(part).filter((w) => !JOB_WORDS.has(w)))
    .filter((words) => words.length > 0);
}

const STRONG = 2;
const WEAK = 1;

/** How well one account matches one employee: STRONG, WEAK or 0. */
function matchLevel(employee, account) {
  const american = nameWords(employee?.american_name);
  const uzbekFirst = nameWords(employee?.first_name)[0] || null;
  let best = 0;
  for (const part of accountNameParts(account)) {
    if (american.length >= 2 && american.every((w) => part.includes(w))) return STRONG;
    if (american.length === 1 && part[0] === american[0]) best = WEAK;
    if (uzbekFirst && part[0] === uzbekFirst) best = WEAK;
  }
  return best;
}

/**
 * @param {Array<{id:number, first_name:string, american_name?:string}>} employees
 * @param {Array<{telegram_user_id:string|number, username?:string, first_name?:string, last_name?:string}>} accounts
 * @returns {Array<{employeeId:number, telegramUserId:string, username:string|null, level:'strong'|'weak'}>}
 */
function suggestTelegramAccounts(employees, accounts) {
  const unique = new Map();
  for (const a of accounts || []) {
    const id = a?.telegram_user_id == null ? '' : String(a.telegram_user_id);
    if (/^[1-9]\d*$/.test(id) && !unique.has(id)) unique.set(id, a);
  }

  const picks = [];
  for (const employee of employees || []) {
    let bestLevel = 0;
    let found = [];
    for (const [id, account] of unique) {
      const level = matchLevel(employee, account);
      if (level > bestLevel) { bestLevel = level; found = [id]; } else if (level && level === bestLevel) found.push(id);
    }
    if (bestLevel && found.length === 1) picks.push({ employee, id: found[0], level: bestLevel });
  }

  const pickedBy = new Map();
  for (const p of picks) pickedBy.set(p.id, (pickedBy.get(p.id) || 0) + 1);
  return picks
    .filter((p) => pickedBy.get(p.id) === 1)
    .map((p) => ({
      employeeId: Number(p.employee.id),
      telegramUserId: p.id,
      username: unique.get(p.id).username || null,
      level: p.level === STRONG ? 'strong' : 'weak',
    }));
}

module.exports = { suggestTelegramAccounts, accountNameParts, matchLevel, nameWords };
