'use strict';

/**
 * Today's birthdays on the race boards (the owner, 6 November 2026): the
 * employees whose card went to the employee group, and the drivers whose wish
 * went to their own group — on /dispatch and /dispatchteam within one poll of
 * the Telegram post.
 *
 * THE ONE OWNER OF THIS STATE. Filled by the two birthday services right after
 * a successful send (`noteBirthday`), and once after a restart from what was
 * sent in the last day (`birthdayRestore.js`). Read by `GET /api/gross-race`,
 * which stays an answer built without a database query.
 *
 * WHAT IS HELD is what the board shows and nothing else: a name, the American
 * name or the truck number, when it went out, and an employee's card as the
 * JPEG that was posted (drawn once, never per request). No Telegram account,
 * no birthday date, no phone. Each entry is kept for a day from its send, at
 * most MAX_HELD of them.
 */
const { titleCaseName } = require('../employees/birthdayText');
const { extractDriverNameFromGroupTitle } = require('../../lib/drivers/driverGroupTitle');

const HOLD_MS = 24 * 60 * 60 * 1000;
const MAX_HELD = 50;
const KINDS = new Set(['employee', 'driver']);
const CARD_PATH = '/api/gross-race/birthday-card/';

const text = (v, max = 80) => String(v == null ? '' : v).trim().replace(/\s+/g, ' ').slice(0, max);

/** A driver's name for the board, from their chat's title: "WENZE UNIT # 1109 JOHN SMITH" → "John Smith". */
function driverBoardName(groupTitle) {
  return titleCaseName(extractDriverNameFromGroupTitle(groupTitle)) || 'Driver';
}

/** The key of one person's birthday: who, and the UTC day it was sent on. */
function birthdayKey(kind, id, sentAt) {
  return `${kind}-${id}-${new Date(sentAt).toISOString().slice(0, 10)}`;
}

function createBirthdayBoard({ now = () => Date.now() } = {}) {
  let held = new Map();

  function prune(at) {
    for (const [key, entry] of held) if (at - entry.sentAt >= HOLD_MS) held.delete(key);
  }

  /**
   * One birthday that went out. Never throws: a hook must not cost anybody
   * their Telegram post.
   * @returns {string|null} the key, or null when the entry was refused
   */
  function noteBirthday({
    kind, id, name, subtitle = null, truck = null, sentAt = now(), card = null,
  } = {}) {
    const shown = text(name);
    const at = Number(new Date(sentAt));
    if (!KINDS.has(kind) || id == null || !/^\d+$/.test(String(id)) || !shown || !Number.isFinite(at)) return null;
    const key = birthdayKey(kind, id, at);
    held.set(key, {
      key,
      kind,
      name: shown,
      subtitle: kind === 'employee' ? text(subtitle) || null : null,
      truck: kind === 'driver' ? text(truck, 12) || null : null,
      sentAt: at,
      card: kind === 'employee' && Buffer.isBuffer(card) && card.length ? card : null,
    });
    prune(now());
    if (held.size > MAX_HELD) {
      held = new Map([...held.entries()].sort((a, b) => b[1].sentAt - a[1].sentAt).slice(0, MAX_HELD));
    }
    return key;
  }

  /** The birthdays still on the boards, oldest send first — what the page may be told. */
  function todaysBirthdays() {
    prune(now());
    return [...held.values()].sort((a, b) => a.sentAt - b.sentAt).map((e) => ({
      key: e.key,
      kind: e.kind,
      name: e.name,
      subtitle: e.subtitle,
      truck: e.truck,
      sentAt: new Date(e.sentAt).toISOString(),
      card: e.card ? `${CARD_PATH}${encodeURIComponent(e.key)}` : null,
    }));
  }

  /** The card JPEG for a birthday still held; null for anything else. */
  function cardFor(key) {
    prune(now());
    const entry = held.get(String(key || ''));
    return entry && entry.card ? entry.card : null;
  }

  /** For tests. */
  function clear() { held = new Map(); }

  return { noteBirthday, todaysBirthdays, cardFor, clear };
}

// The process's one board, shared by the birthday services and the race route.
const board = createBirthdayBoard();

module.exports = {
  HOLD_MS, MAX_HELD, birthdayKey, driverBoardName, createBirthdayBoard, board,
};
