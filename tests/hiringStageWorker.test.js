'use strict';

/**
 * services/hiringStages/worker.js — off means off, and so does a missing
 * Bitrix topic: with the stage proposals switched on but no topic saved, a
 * drain stops `blocked`, names the setting, and does not touch the queue —
 * the conversations wait and nothing is posted anywhere, General included.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
function stub(rel, exports) {
  const filename = require.resolve(path.resolve(ROOT, rel));
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

let settings;
let claims = 0;
let read = 0;
stub('database/safetyApprovals/settings.js', { getSafetyApprovalSettings: async () => settings });
stub('database/hiringStages/threads.js', {
  claimDueThreads: async () => { claims += 1; return claims === 1 ? [{ id: 1 }] : []; },
  purgeOldThreads: async () => 0,
  nextThreadDueAt: async () => null,
});
stub('database/hiringStages/proposals.js', { purgeOldProposals: async () => 0 });
stub('database/hiringStages/crmRecords.js', { purgeOldRecords: async () => 0 });
stub('database/hiringStages/notices.js', { purgeOldNotices: async () => 0 });
stub('database/hiringStages/cards.js', { purgeOldCards: async () => 0 });
stub('services/hiringStages/reviewer.js', { processThread: async () => { read += 1; return 'done'; } });

const { drainHiringStages } = require('../services/hiringStages/worker');

const ON = { enabled: true, stageProposalsEnabled: true, chatId: '-100777', safetyUserIds: ['900'] };
const telegram = { sendMessage: async () => { throw new Error('nothing may be sent'); } };

test('switched on but NO BITRIX TOPIC: blocked, naming the setting; the queue is not touched', async () => {
  settings = { ...ON, bitrixTopicId: null };
  claims = 0; read = 0;
  const out = await drainHiringStages({ telegram });
  assert.match(out.blocked, /no Bitrix topic is saved — Settings → Safety Approvals → 5/);
  assert.equal(claims, 0, 'the conversations wait in the queue');
  assert.equal(read, 0);
});

test('switched off, or Safety Approvals off: blocked as before', async () => {
  settings = { ...ON, stageProposalsEnabled: false, bitrixTopicId: 77 };
  assert.match((await drainHiringStages({ telegram })).blocked, /stage proposals are switched off/);
  settings = { ...ON, enabled: false, bitrixTopicId: 77 };
  assert.match((await drainHiringStages({ telegram })).blocked, /Safety Approvals is switched off/);
});

test('with the topic saved, the queue is read', async () => {
  settings = { ...ON, bitrixTopicId: 77 };
  claims = 0; read = 0;
  const out = await drainHiringStages({ telegram });
  assert.equal(out.blocked, undefined);
  assert.equal(read, 1);
  assert.deepEqual(out, { done: 1 });
});
