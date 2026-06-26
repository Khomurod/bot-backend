/**
 * Bot Group Access — pure helpers (no DB / network), so they can be unit-tested
 * in isolation. The verdict combines the bot's membership role with whether the
 * bot has actually received messages from the group recently.
 */
const RECENT_SEEN_DAYS = 30;

/**
 * Decide whether the bot can read a group, from its role + last-seen activity.
 * @returns {{ reading:string, level:'ok'|'warn'|'bad'|'unknown', label:string }}
 */
function computeReadingVerdict({ memberStatus, lastMessageSeenAt, now = Date.now() } = {}) {
  const seenMs = lastMessageSeenAt ? new Date(lastMessageSeenAt).getTime() : null;
  const seenRecently = Number.isFinite(seenMs)
    && (now - seenMs) <= RECENT_SEEN_DAYS * 24 * 60 * 60 * 1000;
  const isAdmin = memberStatus === 'administrator' || memberStatus === 'creator';
  const notInGroup = memberStatus === 'left' || memberStatus === 'kicked' || memberStatus === 'not_found';

  if (notInGroup) {
    return { reading: 'not_in_group', level: 'bad', label: 'Bot is not in this group' };
  }
  if (isAdmin) {
    return { reading: 'reads_all', level: 'ok', label: 'Admin — reads all messages' };
  }
  if (seenRecently) {
    return { reading: 'reads_active', level: 'ok', label: 'Reading messages' };
  }
  if (memberStatus === 'member' || memberStatus === 'restricted') {
    return {
      reading: 'maybe_blocked',
      level: 'warn',
      label: 'In group as member but no messages received — likely blocked by privacy mode. Make the bot an admin.',
    };
  }
  return { reading: 'unknown', level: 'unknown', label: 'Not checked yet — run "Recheck access"' };
}

// Start-parameter used in the ?startgroup deep link so the bot can verify which
// driver group the super admin chose (Telegram cannot pre-select the group, so
// we tag the link and confirm the result instead).
const ADMIN_GRANT_PREFIX = 'htadmin_';

function buildAdminGrantPayload(groupId) {
  return `${ADMIN_GRANT_PREFIX}${groupId}`;
}

/** Parse our admin-grant start payload → internal group id, or null. */
function parseAdminGrantPayload(payload) {
  const s = String(payload || '');
  if (!s.startsWith(ADMIN_GRANT_PREFIX)) return null;
  const id = Number.parseInt(s.slice(ADMIN_GRANT_PREFIX.length), 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

module.exports = {
  RECENT_SEEN_DAYS,
  computeReadingVerdict,
  ADMIN_GRANT_PREFIX,
  buildAdminGrantPayload,
  parseAdminGrantPayload,
};
