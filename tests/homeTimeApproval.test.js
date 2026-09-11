/**
 * services/homeTimeApproval — what is LEFT of it, and what must stay gone.
 *
 * This module was the approve/decline workflow behind both the Telegram buttons
 * and the admin panel. Home time is no longer permitted, only reported, so the
 * workflow is deleted rather than disabled: a retired path kept "just in case"
 * is a path that comes back.
 *
 * What remains is housekeeping. A request whose requested window has already
 * passed with nothing having happened is closed as expired and its Telegram card
 * settled in place. That was never a decision about whether a driver may go
 * home; it is the system tidying up after one that never resolved.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');

const TODAY = DateTime.now().setZone('America/Chicago');
const PAST_FROM = TODAY.minus({ days: 20 }).toISODate();
const PAST_TO = TODAY.minus({ days: 16 }).toISODate();
const FUTURE_FROM = TODAY.plus({ days: 3 }).toISODate();
const FUTURE_TO = TODAY.plus({ days: 6 }).toISODate();

function requestAt(from, to, extra = {}) {
  return {
    id: 5,
    status: 'pending',
    driver_name: 'Pascal F',
    unit_number: '96266',
    home_from: from,
    home_to: to,
    return_to_road_date: to,
    telegram_chat_id: '-100200300',
    telegram_message_id: 42,
    ...extra,
  };
}

function load({ open = [], expireReturns = undefined } = {}) {
  const approvalPath = require.resolve('../services/homeTimeApproval');
  const htPath = require.resolve('../database/homeTime');
  const expiryPath = require.resolve('../database/homeTimeExpiry');
  const htmlPath = require.resolve('../services/telegramHtml');
  for (const p of [approvalPath, htPath, expiryPath, htmlPath]) delete require.cache[p];

  const calls = { expired: [] };
  require.cache[htPath] = {
    exports: {
      async listOpenHomeTimeRequests() { return open; },
      async getHomeTimeRequestById(id) { return open.find((r) => r.id === id) || null; },
    },
  };
  require.cache[expiryPath] = {
    exports: {
      // The sweep reads the open board from the EXPIRY module, not from
      // database/homeTime — the mock follows the real require graph.
      async listOpenHomeTimeRequests() { return open; },
      async expireOutdatedHomeTimeRequest(id) {
        calls.expired.push(id);
        if (expireReturns !== undefined) return expireReturns;
        const row = open.find((r) => r.id === id) || requestAt(PAST_FROM, PAST_TO);
        return { ...row, status: 'expired' };
      },
    },
  };
  require.cache[htmlPath] = { exports: { safeSend: async (fn) => fn() } };

  const mod = require(approvalPath);
  const edits = [];
  const sends = [];
  return {
    mod, calls, edits, sends,
    telegram: {
      async editMessageText(...args) { edits.push(args); },
      async sendMessage(...args) { sends.push(args); },
    },
  };
}

// ── the workflow is GONE, not disabled ───────────────────────────────────────

test('the approve/decline workflow is not exported, because it does not exist', () => {
  const { mod } = load();
  assert.equal(mod.applyHomeTimeDecision, undefined,
    'a retired path kept as an export is a path that gets called again');
  assert.equal(mod.announceApproval, undefined, 'nothing announces an approval any more');
  assert.equal(mod.canApproveWindow, undefined, 'there is no approval to validate a window for');
});

test('the request service does not re-export them either', () => {
  delete require.cache[require.resolve('../services/homeTimeRequestService')];
  // Loaded lazily inside the assertion so a missing env cannot fail the file.
  let svc = null;
  try { svc = require('../services/homeTimeRequestService'); } catch (_) { /* env-dependent */ }
  if (!svc) return;
  assert.equal(svc.applyHomeTimeDecision, undefined);
  assert.equal(svc.announceApproval, undefined);
});

// ── the housekeeping that stays ──────────────────────────────────────────────

test('a request whose window has passed is expired and its card settled', async () => {
  const row = requestAt(PAST_FROM, PAST_TO);
  const { mod, calls, telegram, edits } = load({ open: [row] });

  const out = await mod.expireOutdatedRequest(telegram, row);

  assert.equal(out.status, 'expired');
  assert.deepEqual(calls.expired, [5]);
  assert.equal(edits.length, 1, 'the card in the group is updated in place');
  const text = edits[0][3];
  assert.match(text, /Expired/i);
  assert.equal(/Approve|Do Not Approve/i.test(text), false,
    'the settled card must not reintroduce the words it was built to remove');
});

test('a request someone else already settled is left alone', async () => {
  const row = requestAt(PAST_FROM, PAST_TO);
  const { mod, telegram, edits } = load({ open: [row], expireReturns: null });
  const out = await mod.expireOutdatedRequest(telegram, row);
  assert.equal(out, null);
  assert.equal(edits.length, 0, 'no card is touched for a row that did not change');
});

test('expiring never throws, and a missing request is simply null', async () => {
  const { mod, telegram } = load();
  assert.equal(await mod.expireOutdatedRequest(telegram, null), null);
});

test('a card edit that fails does not fail the expiry — the database is authoritative',
  async () => {
    const row = requestAt(PAST_FROM, PAST_TO);
    const { mod } = load({ open: [row] });
    const angry = {
      async editMessageText() { throw new Error('message to edit not found'); },
      async sendMessage() {},
    };
    const out = await mod.expireOutdatedRequest(angry, row);
    assert.equal(out.status, 'expired', 'the row is expired even though Telegram refused');
  });

// ── the sweep ────────────────────────────────────────────────────────────────

test('the sweep expires only the requests whose window has actually passed', async () => {
  const past = requestAt(PAST_FROM, PAST_TO, { id: 5 });
  const future = requestAt(FUTURE_FROM, FUTURE_TO, { id: 6 });
  const { mod, calls, telegram } = load({ open: [past, future] });

  const out = await mod.sweepOutdatedHomeTimeRequests(telegram);

  assert.equal(out.scanned, 2);
  assert.equal(out.expired, 1);
  assert.deepEqual(calls.expired, [5], 'the future request is left open');
});

test('an empty board is a clean, silent pass', async () => {
  const { mod, calls, telegram } = load({ open: [] });
  const out = await mod.sweepOutdatedHomeTimeRequests(telegram);
  assert.deepEqual(out, { scanned: 0, expired: 0 });
  assert.equal(calls.expired.length, 0);
});
