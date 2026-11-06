'use strict';

/**
 * services/truckPhotos/triggerHandler.js — whether a word counts, the claim,
 * and the queue. The cases worth pinning: Telegram redelivering the same word
 * makes no second PDF; the driver's own word in a solo group is ignored while
 * the fleet manager's counts; a team group or an unreadable one lets anybody
 * mark; the photo replied to is remembered; reports run one at a time; and
 * nothing here can throw at the bot. Ids are made up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { noticeTruckPhotoTrigger, activeReportIds, __resetForTests } = require('../services/truckPhotos/triggerHandler');

const CHAT = -100555;
const DRIVER = 5001;
const MANAGER = 7002;

function harness(over = {}) {
  const claims = new Set();
  const calls = { runs: [], captured: [], claims: [] };
  const deps = {
    getSettings: async () => ({ enabled: true, recipientTelegramId: '777000', ...over.settings }),
    getGroup: async (id) => (String(id) === String(CHAT) ? { id: 3, group_name: 'Jerome Joyner 1', group_type: over.groupType || 'driver' } : null),
    readDriverContext: over.readDriverContext || (async () => ({
      profile: { first_name: 'Jerome' }, accountIds: [String(DRIVER)], isTeam: over.isTeam ?? false,
    })),
    claimReport: async (row) => {
      calls.claims.push(row);
      const key = `${row.chatId}:${row.triggerMessageId}`;
      if (claims.has(key)) return null;
      claims.add(key);
      return claims.size;
    },
    capture: async (message) => { calls.captured.push(message.message_id); return { captured: true }; },
    run: over.run || (async (job) => { calls.runs.push(job); return { status: 'sent' }; }),
    settleMs: 0,
  };
  return { deps, calls };
}

const word = (over = {}) => ({
  message_id: 100, chat: { id: CHAT, type: 'supergroup' }, from: { id: MANAGER, first_name: 'Kim' },
  date: 1762444800, text: 'outbound', ...over,
});

test('the fleet manager\'s word is claimed and its report runs after the settle delay', async () => {
  __resetForTests();
  const { deps, calls } = harness();
  const out = await noticeTruckPhotoTrigger(word(), { telegram: {} }, deps);
  assert.equal(out.handled, true);
  assert.deepEqual(await out.done, { status: 'sent' });
  assert.equal(calls.runs.length, 1);
  assert.deepEqual(calls.runs[0].trigger, { kind: 'outbound', bare: true });
  assert.deepEqual(calls.claims[0], {
    chatId: String(CHAT), groupId: 3, triggerMessageId: 100, kind: 'outbound', triggeredBy: MANAGER, triggeredByName: 'Kim',
  });
});

test('a redelivered update finds the word claimed: no second report, no second PDF', async () => {
  __resetForTests();
  const { deps, calls } = harness();
  const first = await noticeTruckPhotoTrigger(word(), { telegram: {} }, deps);
  const again = await noticeTruckPhotoTrigger(word(), { telegram: {} }, deps);
  await first.done;
  assert.equal(again.handled, false);
  assert.equal(again.reason, 'already_claimed');
  assert.equal(calls.runs.length, 1);
});

test('solo group: the driver\'s own word is ignored — no claim, no report', async () => {
  __resetForTests();
  const { deps, calls } = harness();
  const out = await noticeTruckPhotoTrigger(word({ from: { id: DRIVER, first_name: 'Jerome' } }), {}, deps);
  assert.equal(out.reason, 'the_driver');
  assert.equal(calls.claims.length, 0);
  assert.equal(calls.runs.length, 0);
});

test('team group, or a driver context that cannot be read: the driver may mark too', async () => {
  __resetForTests();
  const team = harness({ isTeam: true });
  const out = await noticeTruckPhotoTrigger(word({ from: { id: DRIVER } }), {}, team.deps);
  assert.equal(out.handled, true);
  await out.done;

  const unreadable = harness({ readDriverContext: async () => { throw new Error('database is down'); } });
  const again = await noticeTruckPhotoTrigger(word({ message_id: 101, from: { id: DRIVER } }), {}, unreadable.deps);
  assert.equal(again.handled, true);
  await again.done;
});

test('off, no recipient, not a driver group, a bot, or no word: nothing at all', async () => {
  __resetForTests();
  const cases = [
    [harness({ settings: { enabled: false } }), word(), 'switched_off'],
    [harness({ settings: { recipientTelegramId: null } }), word(), 'switched_off'],
    [harness({ groupType: 'recruitment' }), word(), 'not_a_driver_group'],
    [harness(), word({ from: { id: 1, is_bot: true } }), 'not_a_person'],
    [harness(), word({ chat: { id: 42, type: 'private' } }), 'not_a_group'],
    [harness(), word({ text: 'outbound/inbound' }), 'no_trigger'],
    [harness(), word({ text: 'on my way' }), 'no_trigger'],
  ];
  for (const [{ deps, calls }, message, reason] of cases) {
    // eslint-disable-next-line no-await-in-loop
    const out = await noticeTruckPhotoTrigger(message, {}, deps);
    assert.equal(out.reason, reason);
    assert.equal(calls.claims.length, 0, reason);
  }
});

test('a captioned photo is a trigger too; a word with more around it is not bare', async () => {
  __resetForTests();
  const { deps, calls } = harness();
  const out = await noticeTruckPhotoTrigger(word({ text: undefined, caption: 'Inbound truck 562', photo: [{ file_id: 'f' }] }), {}, deps);
  await out.done;
  assert.deepEqual(calls.runs[0].trigger, { kind: 'inbound', bare: false });
});

test('the photo the word replies to is remembered before the report runs', async () => {
  __resetForTests();
  const { deps, calls } = harness();
  const reply = { message_id: 90, chat: { id: CHAT, type: 'supergroup' }, from: { id: DRIVER }, photo: [{ file_id: 'f' }] };
  const out = await noticeTruckPhotoTrigger(word({ reply_to_message: reply }), {}, deps);
  await out.done;
  assert.deepEqual(calls.captured, [90]);
});

test('reports run one at a time, in the order they were claimed', async () => {
  __resetForTests();
  const events = [];
  let releaseFirst;
  const firstHeld = new Promise((resolve) => { releaseFirst = resolve; });
  const { deps } = harness({
    run: async (job) => {
      events.push(`start:${job.message.message_id}`);
      if (job.message.message_id === 100) await firstHeld;
      events.push(`end:${job.message.message_id}`);
      return { ok: true };
    },
  });
  const a = await noticeTruckPhotoTrigger(word({ message_id: 100 }), {}, deps);
  const b = await noticeTruckPhotoTrigger(word({ message_id: 101 }), {}, deps);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['start:100'], 'the second waits while the first holds its photos');
  assert.deepEqual(activeReportIds().sort(), [a.reportId, b.reportId].sort(), 'both are this process\'s, for the sweep');
  releaseFirst();
  await Promise.all([a.done, b.done]);
  assert.deepEqual(events, ['start:100', 'end:100', 'start:101', 'end:101']);
  assert.deepEqual(activeReportIds(), [], 'a finished report is no longer protected');
});

test('nothing it does can throw at the bot', async () => {
  __resetForTests();
  const { deps } = harness();
  deps.getSettings = async () => { throw new Error('database is down'); };
  const out = await noticeTruckPhotoTrigger(word(), {}, deps);
  assert.deepEqual(out, { handled: false, reason: 'error' });

  const failing = harness({ run: async () => { throw new Error('boom'); } });
  const ran = await noticeTruckPhotoTrigger(word({ message_id: 300 }), {}, failing.deps);
  assert.deepEqual(await ran.done, { error: 'boom' }, 'a report that throws settles, and the queue keeps going');
  assert.equal((await noticeTruckPhotoTrigger(undefined, {}, failing.deps)).reason, 'no_trigger');
});

test('a reply to a photo Wenze had not seen — sent before it was looking — tells the report its album may be incomplete', async () => {
  __resetForTests();
  const { deps, calls } = harness();
  deps.capture = async (m) => { calls.captured.push(m.message_id); return { captured: true, isNew: true }; };
  const old = { message_id: 33, chat: { id: CHAT, type: 'supergroup' }, from: { id: DRIVER }, date: 1762444800 - 10 * 86400, photo: [{ file_id: 'p' }] };
  const out = await noticeTruckPhotoTrigger(word({ reply_to_message: old }), { telegram: {} }, deps);
  await out.done;
  assert.deepEqual(calls.captured, [33]);
  assert.equal(calls.runs[0].anchorSeenLate, true);
});

test('a reply to a photo already remembered, or to one sent a moment before the word, is not "seen late"', async () => {
  for (const [isNew, ageSeconds] of [[false, 10 * 86400], [true, 30]]) {
    __resetForTests();
    const { deps, calls } = harness();
    deps.capture = async () => ({ captured: true, isNew });
    const replied = { message_id: 33, chat: { id: CHAT, type: 'supergroup' }, from: { id: DRIVER }, date: 1762444800 - ageSeconds, photo: [{ file_id: 'p' }] };
    const out = await noticeTruckPhotoTrigger(word({ reply_to_message: replied }), { telegram: {} }, deps);
    await out.done;
    assert.equal(calls.runs[0].anchorSeenLate, false, `isNew ${isNew}, ${ageSeconds}s old`);
  }
});
