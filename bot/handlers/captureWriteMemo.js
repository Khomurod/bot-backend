'use strict';

/**
 * WRITES THAT WOULD CHANGE NOTHING ARE NOT SENT — the memory behind that rule
 * for bot/handlers/groupCaptureHandlers.js.
 *
 * Every message used to re-write the sender's `drivers` and `group_members`
 * rows, re-run two Telegram-id backfills that had long since found nothing to
 * fill, and re-stamp the group's last-seen time — about seven statements per
 * message, at roughly ten thousand messages a day, when the hosted database's
 * monthly transfer allowance ran short (October 2026). A write is repeated here
 * only when what it would write has CHANGED, or its refresh window has passed:
 *   - names and membership refresh every 15 minutes, so `group_members.last_seen_at`
 *     is at most that far behind (it only orders the admin's username dropdown);
 *   - the backfills retry every 6 hours, because once one has filled its id it
 *     can never match again;
 *   - the group's last-seen stamp, a diagnostic, refreshes every 5 minutes.
 * `bot_users` is still written on every message: it counts them.
 *
 * key → { signature, at }. A write that FAILS is forgotten, so the next message
 * tries again. Owned by this module.
 */
const SEEN_REFRESH_MS = 15 * 60 * 1000;
const BACKFILL_RETRY_MS = 6 * 60 * 60 * 1000;
const GROUP_SEEN_REFRESH_MS = 5 * 60 * 1000;
const MAX_REMEMBERED = 20000;
const lastWrites = new Map();

function writeIsDue(key, signature, ttlMs, now = Date.now()) {
  const prev = lastWrites.get(key);
  if (prev && prev.signature === signature && now - prev.at < ttlMs) return false;
  if (lastWrites.size >= MAX_REMEMBERED) lastWrites.clear();
  lastWrites.set(key, { signature, at: now });
  return true;
}

function forgetWrite(key) {
  lastWrites.delete(key);
}

/** For tests: start from a process that has written nothing. */
function resetCaptureMemory() {
  lastWrites.clear();
}

const nameSignature = (u) => [u.username || '', u.first_name || '', u.last_name || ''].join('|');

module.exports = {
  writeIsDue,
  forgetWrite,
  resetCaptureMemory,
  nameSignature,
  SEEN_REFRESH_MS,
  BACKFILL_RETRY_MS,
  GROUP_SEEN_REFRESH_MS,
};
