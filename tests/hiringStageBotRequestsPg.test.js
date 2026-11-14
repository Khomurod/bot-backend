'use strict';

/**
 * Migration 0106 against a real PostgreSQL: a conversation a person ASKED for
 * with a tag (the first person kept, the newest tag answered, the short
 * settle, a second tag only re-queuing it), a post rebuilt from a tag's
 * `reply_to_message` (flagged until a real capture arrives), and a request to
 * the bot stored as one for good. Names and numbers are made up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();
const CHAT = '-1001234567890';

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const layer = h.loadDataLayer(['safetyApprovals/messages', 'hiringStages/threads']);
  return { h, messages: layer['safetyApprovals/messages'], threads: layer['hiringStages/threads'] };
}

function shaped(messageId, over = {}) {
  return {
    chatId: CHAT, messageId, threadId: null, mediaGroupId: null, fromUserId: 500, fromName: 'Kim R',
    text: null, photos: [], documents: [], replyToMessageId: null,
    sentAt: new Date('2026-11-14T09:00:00Z'), editedAt: null, ...over,
  };
}

const ask = (threads, requestMessageId, userId, name) => threads.requestThread({
  chatId: CHAT, rootMessageId: 169, requestMessageId, requestedByUserId: userId, requestedByName: name, settleSeconds: 60,
});

test('the columns exist, are additive, and the migration can run twice', { skip: skipWithoutPg() }, async (t) => {
  const { h } = await setup(t);
  const { rows } = await h.pool.query(
    `SELECT table_name, column_name, is_nullable, column_default FROM information_schema.columns
      WHERE (table_name = 'hiring_stage_threads' AND column_name IN ('requested_at', 'requested_by_user_id', 'requested_by_name', 'request_message_id'))
         OR (table_name = 'safety_approval_messages' AND column_name IN ('recovered_from_reply', 'bot_request'))
      ORDER BY table_name, column_name`,
  );
  assert.deepEqual(rows.map((r) => `${r.table_name}.${r.column_name}:${r.is_nullable}`), [
    'hiring_stage_threads.request_message_id:YES',
    'hiring_stage_threads.requested_at:YES',
    'hiring_stage_threads.requested_by_name:YES',
    'hiring_stage_threads.requested_by_user_id:YES',
    'safety_approval_messages.bot_request:NO',
    'safety_approval_messages.recovered_from_reply:NO',
  ]);
  await h.pool.query(allMigrationsSql((name) => name.startsWith('0106_')));
});

test('A REQUEST queues the conversation in a minute; the FIRST person is kept, the NEWEST tag answered',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, threads } = await setup(t);
    // An ordinary reply queued it first, for ten minutes.
    const plain = await threads.enqueueThread({ chatId: CHAT, rootMessageId: 169, lastMessageId: 172, settleSeconds: 600 });
    assert.equal(plain.requestedAt, null);

    const first = await ask(threads, 175, '4242', 'Ann Lee');
    assert.ok(first.requestedAt);
    assert.deepEqual([first.requestedByUserId, first.requestedByName, first.requestMessageId], ['4242', 'Ann Lee', 175]);
    assert.equal(first.revision, plain.revision + 1);
    assert.equal(first.lastMessageId, 175);
    const { rows: [due] } = await h.pool.query(
      "SELECT due_at < NOW() + INTERVAL '70 seconds' AND due_at > NOW() + INTERVAL '50 seconds' AS soon FROM hiring_stage_threads",
    );
    assert.equal(due.soon, true, 'a minute, not ten');

    const second = await ask(threads, 181, '5151', 'Bo');
    assert.equal(second.id, first.id, 'one thread');
    assert.equal(second.revision, first.revision + 1, 'a second tag only bumps the revision');
    assert.deepEqual([second.requestedByUserId, second.requestedByName], ['4242', 'Ann Lee'], 'the first requester is kept');
    assert.equal(second.requestMessageId, 181, 'the newest tag gets the answer');
    assert.equal(+new Date(second.requestedAt), +new Date(first.requestedAt));
    const stale = await ask(threads, 178, '6262', 'Cy');
    assert.equal(stale.requestMessageId, 181, 'a tag delivered late does not take the answer back');

    // A later ordinary message keeps the request.
    const later = await threads.enqueueThread({ chatId: CHAT, rootMessageId: 169, lastMessageId: 190, settleSeconds: 600 });
    assert.deepEqual([later.requestedByName, later.requestMessageId, later.status], ['Ann Lee', 181, 'pending']);
    await h.pool.query("UPDATE hiring_stage_threads SET due_at = NOW() - INTERVAL '1 second'");
    const [claimed] = await threads.claimDueThreads({ limit: 1 });
    assert.deepEqual([claimed.requestedByUserId, claimed.requestMessageId], ['4242', 181]);
  });

test('A REBUILT POST stays flagged only until a real capture; a request to the bot stays one for good',
  { skip: skipWithoutPg() }, async (t) => {
    const { messages, threads } = await setup(t);
    await messages.upsertMessage(shaped(169, { text: 'KWAME ASANTE', recoveredFromReply: true }));
    let post = await messages.getMessage(CHAT, 169);
    assert.deepEqual([post.recoveredFromReply, post.botRequest], [true, false]);

    // The post edited and seen for real (edited_message): no longer "recovered".
    await messages.upsertMessage(shaped(169, { text: 'KWAME ASANTE\n(555) 201-3344', editedAt: new Date('2026-11-14T09:05:00Z') }));
    post = await messages.getMessage(CHAT, 169);
    assert.deepEqual([post.recoveredFromReply, post.text], [false, 'KWAME ASANTE\n(555) 201-3344']);
    // A later refresh from a tag cannot flag a real capture as recovered.
    await messages.upsertMessage(shaped(169, { text: 'KWAME ASANTE\n(555) 201-3344', recoveredFromReply: true }));
    assert.equal((await messages.getMessage(CHAT, 169)).recoveredFromReply, false);

    // A refresh keeps what a stored reply replies to (the copy does not say).
    await messages.upsertMessage(shaped(172, { text: 'CLH sent', replyToMessageId: 169 }));
    await messages.upsertMessage(shaped(172, { text: 'CLH sent!', recoveredFromReply: true }));
    assert.equal((await messages.getMessage(CHAT, 172)).replyToMessageId, 169);

    await messages.upsertMessage(shaped(175, { text: '@wenze_bot', replyToMessageId: 169, botRequest: true }));
    await messages.upsertMessage(shaped(175, { text: 'edited without the mention', replyToMessageId: 169, botRequest: false }));
    assert.equal((await messages.getMessage(CHAT, 175)).botRequest, true, 'once a request, never data');
    const read = await threads.listThreadMessages(CHAT, 169);
    assert.deepEqual(read.map((m) => [m.messageId, m.botRequest]), [[169, false], [172, false], [175, true]]);
  });
