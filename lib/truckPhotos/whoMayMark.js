'use strict';

/**
 * May this person's `outbound` / `inbound` make a PDF? Pure.
 *
 * THE OWNER'S RULE (6 November 2026): anybody may mark the hand-over except
 * the group's own driver — the fleet manager, a dispatcher, the owner. The
 * driver handing a truck over is not the one who signs it off.
 *
 * So the answer is NO in exactly one case: a SOLO group (one driver on the
 * profile) whose driver's Telegram account is KNOWN, and the author is that
 * account. Everything else is yes:
 *
 *   - the driver's account is not linked — nobody can tell the driver apart
 *     from the manager, and a refusal would refuse the manager too;
 *   - a TEAM group (two drivers) — the owner allows the driver there;
 *   - the group cannot be read at all (`isTeam` unknown) — the feature is
 *     useless if a database hiccup silences every hand-over, and the worst a
 *     wrong yes does is send one PDF to the one person who asked for them.
 *
 * "The driver's accounts" are every OPEN Telegram identity of the person on
 * the chat plus the profile's own `telegram_user_id`
 * (database/truckPhotos/driverContext.js). A username is never evidence
 * (docs/architecture/telegram-identity.md) and is not looked at.
 */

/**
 * @param {object} input
 * @param {*} input.authorId                the Telegram user id who wrote the word
 * @param {Array<*>} [input.driverAccountIds] the driver's known account ids
 * @param {boolean|null} [input.isTeam]      true team, false solo, null unknown
 * @returns {boolean}
 */
function mayMark({ authorId, driverAccountIds = [], isTeam = null } = {}) {
  if (isTeam !== false) return true;
  if (authorId === null || authorId === undefined) return true;
  const author = String(authorId);
  return !(driverAccountIds || []).some((id) => id !== null && id !== undefined && String(id) === author);
}

module.exports = { mayMark };
