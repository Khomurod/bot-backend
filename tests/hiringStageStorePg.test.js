'use strict';

/**
 * The hiring-stage stores against a real PostgreSQL: migration 0076, the
 * reply tree a conversation is read from, the queue's revision and lease,
 * one open proposal per conversation, a button press claimed once, and the
 * switch. Names are made up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();
const CHAT = '-1001234567890';

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const layer = h.loadDataLayer([
    'safetyApprovals/messages', 'safetyApprovals/settings', 'hiringStages/threads', 'hiringStages/proposals',
  ]);
  return {
    h,
    messages: layer['safetyApprovals/messages'],
    settings: layer['safetyApprovals/settings'],
    threads: layer['hiringStages/threads'],
    proposals: layer['hiringStages/proposals'],
  };
}

function shaped(messageId, over = {}) {
  return {
    chatId: CHAT, messageId, threadId: null, mediaGroupId: null, fromUserId: 500, fromName: 'Kim R',
    text: null, photos: [], documents: [], replyToMessageId: null,
    sentAt: new Date('2026-10-19T19:42:25Z'), editedAt: null, ...over,
  };
}

test('a conversation is its post, its album, and every reply at any depth — nothing else',
  { skip: skipWithoutPg() }, async (t) => {
    const { messages, threads } = await setup(t);
    for (const m of [
      shaped(169, { mediaGroupId: 'g1', text: 'SAMUEL PHILLIPS', photos: [{ file_id: 'a' }] }),
      shaped(170, { mediaGroupId: 'g1', photos: [{ file_id: 'b' }] }),
      shaped(172, { fromUserId: 900, text: 'CLH sent', replyToMessageId: 169 }),
      shaped(173, { text: 'Done', replyToMessageId: 172 }),
      shaped(174, { fromUserId: 900, text: 'CLEAN', replyToMessageId: 173 }),
      shaped(177, { fromUserId: 900, mediaGroupId: 'g2', replyToMessageId: 170, documents: [{ file_name: 'MVR.pdf' }] }),
      shaped(178, { fromUserId: 900, mediaGroupId: 'g2', documents: [{ file_name: 'PSP.pdf' }] }),
      shaped(181, { text: 'another driver entirely' }),
      shaped(182, { text: 'reply to the other one', replyToMessageId: 181 }),
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await messages.upsertMessage(m);
    }
    const ids = (await threads.listThreadMessages(CHAT, 169)).map((m) => m.messageId);
    assert.deepEqual(ids, [169, 170, 172, 173, 174, 177, 178]);
  });

test('the queue: a burst is one row, a mid-read change is read again, a lease is held',
  { skip: skipWithoutPg() }, async (t) => {
    const { threads } = await setup(t);
    await threads.enqueueThread({ chatId: CHAT, rootMessageId: 169, lastMessageId: 172, settleSeconds: 0 });
    await threads.enqueueThread({ chatId: CHAT, rootMessageId: 169, lastMessageId: 174, settleSeconds: 0 });
    const [claimed] = await threads.claimDueThreads({ limit: 5 });
    assert.equal(claimed.lastMessageId, 174);
    assert.equal(claimed.revision, 1);
    assert.deepEqual(await threads.claimDueThreads({ limit: 5 }), [], 'leased');

    await threads.enqueueThread({ chatId: CHAT, rootMessageId: 169, lastMessageId: 173, settleSeconds: 0 });
    assert.equal(await threads.finishThread(claimed, { outcome: { result: 'proposed' } }), false, 'a stale finish loses');
    const [again] = await threads.claimDueThreads({ limit: 5 });
    assert.equal(again.lastMessageId, 174, 'an older message never moves the reply target back');
    assert.equal(await threads.finishThread(again, { outcome: { result: 'no_change' } }), true);
    assert.equal(await threads.nextThreadDueAt(), null);
  });

test('ONE OPEN PROPOSAL PER CONVERSATION, and a press is claimed exactly once',
  { skip: skipWithoutPg() }, async (t) => {
    const { proposals } = await setup(t);
    const base = {
      chatId: CHAT, rootMessageId: 169, kind: 'move', driverName: 'Samuel Phillips', dealId: 12,
      dealTitle: 'Facebook Lead – Samuel Phillips', categoryId: '0', fromStageId: 'PREPARATION',
      fromStageName: 'CLEARINGHOUSE CHECK', toStageId: 'EXECUTING', toStageName: 'MVR + PSP CHECK',
      evidence: 'CLEAN', recruiterUserId: '500', recruiterName: 'Kim R',
    };
    const first = await proposals.reserveProposal(base);
    assert.ok(first.id);
    assert.equal(await proposals.reserveProposal({ ...base, toStageId: 'FINAL_INVOICE', toStageName: 'READY' }), null);
    await proposals.recordSent(first.id, 9001);

    const [a, b] = await Promise.all([
      proposals.transition(first.id, 'pending', 'applying', { userId: 1, userName: 'Ann' }),
      proposals.transition(first.id, 'pending', 'applying', { userId: 2, userName: 'Bo' }),
    ]);
    assert.equal([a, b].filter(Boolean).length, 1, 'two presses, one claim');
    const applied = await proposals.transition(first.id, 'applying', 'applied');
    assert.equal(applied.status, 'applied');
    assert.ok(applied.decidedAt);
    assert.equal(applied.botMessageId, 9001);

    const second = await proposals.reserveProposal({ ...base, toStageId: 'FINAL_INVOICE', toStageName: 'READY' });
    assert.ok(second, 'a closed proposal frees the conversation');
    assert.deepEqual((await proposals.listForRoot(CHAT, 169)).map((p) => p.id), [second.id, first.id]);

    const ask = await proposals.reserveProposal({ ...base, rootMessageId: 200, kind: 'create_deal', dealId: null });
    await proposals.transition(ask.id, 'pending', 'applying');
    const moved = await proposals.attachDeal(ask.id, {
      dealId: 30, dealTitle: 'Deal 30', categoryId: '0', fromStageId: 'NEW', fromStageName: 'New',
      toStageId: 'EXECUTING', toStageName: 'MVR + PSP CHECK',
    });
    assert.equal(moved.kind, 'move');
    assert.equal(moved.status, 'pending');
    assert.equal(moved.dealId, 30);
    assert.equal((await proposals.listRecentProposals(10)).length, 3);
  });

test('the switch is off by default and saved on its own', { skip: skipWithoutPg() }, async (t) => {
  const { settings } = await setup(t);
  settings.invalidateCache();
  assert.equal((await settings.getSafetyApprovalSettings()).stageProposalsEnabled, false);
  const saved = await settings.updateSafetyApprovalSettings({ stageProposalsEnabled: true });
  assert.equal(saved.stageProposalsEnabled, true);
  const kept = await settings.updateSafetyApprovalSettings({ safetyUserIds: ['900'] });
  assert.equal(kept.stageProposalsEnabled, true, 'another save keeps it');
});

test('after sixty days a closed proposal and a finished queue row are deleted; open ones stay',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, proposals, threads } = await setup(t);
    const base = { chatId: CHAT, kind: 'move', toStageId: 'EXECUTING', toStageName: 'MVR + PSP CHECK' };
    const old = await proposals.reserveProposal({ ...base, rootMessageId: 1 });
    await proposals.transition(old.id, 'pending', 'declined');
    const open = await proposals.reserveProposal({ ...base, rootMessageId: 2 });
    await h.pool.query("UPDATE hiring_stage_proposals SET created_at = NOW() - INTERVAL '61 days'");
    assert.equal(await proposals.purgeOldProposals(60), 1);
    assert.deepEqual((await proposals.listRecentProposals(10)).map((p) => p.id), [open.id]);

    const row = await threads.enqueueThread({ chatId: CHAT, rootMessageId: 1, lastMessageId: 1, settleSeconds: 0 });
    const [claimed] = await threads.claimDueThreads();
    await threads.finishThread(claimed, { outcome: { result: 'no_change' } });
    await h.pool.query("UPDATE hiring_stage_threads SET updated_at = NOW() - INTERVAL '61 days' WHERE id = $1", [row.id]);
    assert.equal(await threads.purgeOldThreads(60), 1);
  });
