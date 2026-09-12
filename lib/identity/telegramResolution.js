/**
 * Which Telegram account belongs to a driver — PURE, no I/O.
 *
 * A driver group contains the driver and, very often, a dispatcher, a manager,
 * the owner, and somebody who was added once and never left. Picking the driver
 * out of that room is a guess unless the evidence is narrow, and a wrong guess
 * puts one person's account on another person's record — after which every
 * "who is this" lookup through that account answers with the wrong human.
 *
 * SO THE RULE IS DELIBERATELY MEAN. It links only when a SINGLE-driver chat has
 * exactly ONE plausible candidate AND that candidate's Telegram name agrees
 * with the driver's. Everything else is a question.
 *
 * NEVER ON A USERNAME. A username is reassignable: its owner can change it and
 * a stranger can claim the old one the next day. `username_at_link` is recorded
 * so a human reading the row recognises the account, and nothing matches on it.
 *
 * WHO IS EXCLUDED BEFORE ANY MATCHING HAPPENS, and why each:
 *
 *   bots                     obviously.
 *   already linked elsewhere  one human per account at a time is the schema's
 *                             anchor; offering a taken account as a candidate
 *                             would propose a correction the database refuses.
 *   staff                    a dispatcher is in every driver's chat and would
 *                             otherwise be the "one candidate" in dozens of
 *                             them. Two independent signals: `bot_users.source`
 *                             saying dispatcher or admin, and — the one that
 *                             catches an unlabelled manager — being present in
 *                             three or more driver groups. A driver is in one.
 */
const { driverNamesMatch, normalizePersonName } = require('../drivers/driverGroupTitle');

/** Somebody in three or more driver chats is not a driver. */
const STAFF_GROUP_COUNT = 3;
/** A single candidate whose name agrees. Nothing else may act. */
const LINK_CONFIDENCE = 90;

const CHECKS = Object.freeze({
  UNNAMED: 'identity.telegram_member_unnamed',
  AMBIGUOUS: 'identity.telegram_members_ambiguous',
});

/**
 * Is this account somebody who works here rather than a driver?
 *
 * @param {object} member  { source, driverGroupCount }
 */
function isStaff(member) {
  if (!member) return false;
  const source = String(member.source || '').toLowerCase();
  if (source === 'dispatcher' || source === 'admin') return true;
  return Number(member.driverGroupCount || 0) >= STAFF_GROUP_COUNT;
}

/** The name Telegram shows for an account, for name comparison only. */
function memberName(member) {
  return [member?.firstName, member?.lastName].filter(Boolean).join(' ').trim();
}

/**
 * Everyone in the room who could plausibly be a driver.
 *
 * Exported because the CHECK needs the same filtering to explain itself — "we
 * looked at three people and could not tell" is a different sentence from "the
 * only person in there is your dispatcher".
 */
function plausibleCandidates(members = []) {
  return members.filter((m) => m
    && m.telegramUserId != null
    && m.isBot !== true
    && m.alreadyLinked !== true
    && !isStaff(m));
}

/**
 * Decide one driver's Telegram account.
 *
 * @param {object} input
 * @param {string} input.driverName   the name on the profile
 * @param {Array} input.members       everyone in the chat
 * @param {boolean} [input.isTeamChat] a chat with two drivers in it
 * @param {boolean} [input.alreadyLinked] the person already has an open account
 * @returns {{action:'none'|'link'|'ask', telegramUserId:string|null,
 *            confidence:number|null, checkKey:string|null, reason:string,
 *            candidates:number}}
 */
function decideTelegramLink({
  driverName = '', members = [], isTeamChat = false, alreadyLinked = false,
} = {}) {
  const candidates = plausibleCandidates(members);
  const base = { telegramUserId: null, confidence: null, checkKey: null, candidates: candidates.length };

  if (alreadyLinked) {
    return { ...base, action: 'none', reason: 'this person already has an account recorded' };
  }
  if (!normalizePersonName(driverName)) {
    return { ...base, action: 'none', reason: 'the profile names nobody to match against' };
  }
  if (candidates.length === 0) {
    return {
      ...base, action: 'none',
      reason: members.length
        ? 'everybody in the chat is a bot, staff, or already linked'
        : 'nobody has been seen in the chat',
    };
  }

  // A TEAM CHAT IS NEVER RESOLVED BY THIS RULE. Two drivers and two candidates
  // gives no way to tell which account is which without reading messages, and
  // reading messages to decide identity is not something this does.
  if (isTeamChat) {
    return {
      ...base, action: 'ask', checkKey: CHECKS.AMBIGUOUS,
      reason: 'a team chat has two drivers in it, and which account is which is a judgement',
    };
  }

  if (candidates.length > 1) {
    return {
      ...base, action: 'ask', checkKey: CHECKS.AMBIGUOUS,
      reason: `${candidates.length} people in the chat could be the driver`,
    };
  }

  const [only] = candidates;
  // THE LOOSE NAME MATCHER IS RIGHT HERE, and is not in `boardResolution`.
  // There the candidates were the whole fleet and a shared surname was a real
  // risk; here the field is ONE person in this driver's own chat, and the
  // question is only whether the account looks like them at all. A Telegram
  // display name is a nickname as often as a legal name, so demanding an exact
  // match would refuse almost every true link.
  if (driverNamesMatch(driverName, memberName(only))) {
    return {
      ...base,
      action: 'link',
      telegramUserId: String(only.telegramUserId),
      confidence: LINK_CONFIDENCE,
      reason: 'one person in the chat, and their name matches the driver',
    };
  }

  return {
    ...base, action: 'ask', checkKey: CHECKS.UNNAMED,
    reason: 'one person in the chat, but their Telegram name does not look like the driver',
  };
}

module.exports = {
  CHECKS,
  STAFF_GROUP_COUNT,
  LINK_CONFIDENCE,
  isStaff,
  memberName,
  plausibleCandidates,
  decideTelegramLink,
};
