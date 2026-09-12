'use strict';

/**
 * The control channel against the real schema.
 *
 * Four things here exist only in SQL, so no stub can prove them:
 *   the seeded operator IS the id the application already trusts;
 *   the redelivery guard is a UNIQUE constraint, not a JavaScript check;
 *   `(chat_id, telegram_message_id)` finds the notice a reply is answering;
 *   `telegram:<id>` gets an approval-tier correction past the CHECK that
 *   refuses one from 'system'.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');
const { CREATOR_USER_ID } = require('../bot/creatorMessageManager');

const ALL_MIGRATIONS = allMigrationsSql();

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const loaded = h.loadDataLayer([
    'controlSettings', 'controlOperators', 'controlReplies', 'operationalNotifications',
  ]);
  return { h, ...loaded };
}

test('THE SEEDED OPERATOR IS THE ID THE APPLICATION ALREADY TRUSTS', {
  skip: skipWithoutPg(),
}, async (t) => {
  // Read from the migration text as well as the database: a literal that drifts
  // from `CREATOR_USER_ID` would hand the channel to a stranger's account, and
  // the migration is where that literal lives.
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'database', 'migrations', '0048_control_channel.sql'), 'utf8'
  );
  assert.ok(sql.includes(String(CREATOR_USER_ID)), 'the migration seeds a different id');

  const { controlOperators } = await setup(t);
  const operators = await controlOperators.listControlOperators();
  assert.deepEqual(operators.map((o) => o.telegramUserId), [String(CREATOR_USER_ID)]);
  assert.equal(await controlOperators.isControlOperator(CREATOR_USER_ID), true);
});

test('somebody who is not on the list is not obeyed', { skip: skipWithoutPg() }, async (t) => {
  const { controlOperators } = await setup(t);
  assert.equal(await controlOperators.isControlOperator('999999'), false);
  assert.equal(await controlOperators.isControlOperator(null), false);
});

test('an operator can be added and removed — but never the last one', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { controlOperators } = await setup(t);
  await controlOperators.addControlOperator({ telegramUserId: '555001', label: 'Dispatcher' });
  assert.equal(await controlOperators.isControlOperator('555001'), true);

  await controlOperators.removeControlOperator('555001');
  assert.equal(await controlOperators.isControlOperator('555001'), false);

  await assert.rejects(
    () => controlOperators.removeControlOperator(String(CREATOR_USER_ID)),
    (err) => err.code === 'LAST_OPERATOR',
    'removing the last operator would leave nobody able to steer Wenze'
  );
});

test('a username is refused — an allow-list keyed on one is no allow-list', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { controlOperators } = await setup(t);
  await assert.rejects(
    () => controlOperators.addControlOperator({ telegramUserId: '@somebody' }),
    (err) => err.code === 'INVALID_TELEGRAM_USER_ID'
  );
});

test('the settings row exists on the first boot, with the switch on', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { controlSettings } = await setup(t);
  const settings = await controlSettings.getControlSettings({ force: true });
  assert.equal(settings.enabled, true);
  assert.equal(settings.maxQuestionsPerPass, 5);
  assert.equal(settings.repeatAfterHours, 72);
});

test('a limit outside what the schema allows is clamped, not refused', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { controlSettings } = await setup(t);
  const saved = await controlSettings.updateControlSettings({
    maxQuestionsPerPass: 500, repeatAfterHours: 0,
  }, { updatedBy: 'test' });
  assert.equal(saved.maxQuestionsPerPass, 20);
  assert.equal(saved.repeatAfterHours, 1);
});

test('a reply finds the notice it is answering, newest first', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { h, operationalNotifications } = await setup(t);
  const store = operationalNotifications;

  const first = await store.enqueueNotification({
    noticeKey: 'needs_attention:control_question:11:r0',
    category: 'needs_attention', chatId: '-100777', body: 'Close it?',
    question: { findingId: 11, offeredActions: [{ key: 'dismiss' }] },
  });
  await store.markNotificationDelivered(first.id, { telegramMessageId: 4321 });

  const found = await store.findNoticeByTelegramMessage('-100777', 4321);
  assert.equal(found.id, first.id);
  assert.equal(found.question.findingId, 11);

  // The same message id in a different chat is a different message.
  assert.equal(await store.findNoticeByTelegramMessage('-100888', 4321), null);

  // The index this lookup depends on exists.
  const idx = await h.query(
    `SELECT 1 FROM pg_indexes WHERE tablename = 'operational_notifications'
       AND indexname = 'idx_operational_notifications_tg_message'`
  );
  assert.equal(idx.rowCount, 1);
});

test('THE REDELIVERY GUARD IS A CONSTRAINT — a second claim on the same reply loses', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { controlReplies } = await setup(t);
  const row = {
    chatId: '-100777', replyMessageId: 5000, repliedToMessageId: 4321,
    telegramUserId: String(CREATOR_USER_ID), authorised: true,
    rawText: 'yes', outcome: 'no_op',
  };
  const first = await controlReplies.recordReply(row);
  assert.ok(first?.id);

  const second = await controlReplies.recordReply(row);
  assert.equal(second, null, 'a redelivered reply must not be acted on twice');

  // The same message id in another chat is a different reply.
  const elsewhere = await controlReplies.recordReply({ ...row, chatId: '-100888' });
  assert.ok(elsewhere?.id);
});

test('an unauthorised reply is recorded, with the refusal as its outcome', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { controlReplies } = await setup(t);
  const row = await controlReplies.recordReply({
    chatId: '-100777', replyMessageId: 6000, telegramUserId: '999999',
    authorised: false, rawText: 'yes', outcome: 'ignored_unauthorised',
  });
  assert.equal(row.authorised, false);
  assert.equal(row.outcome, 'ignored_unauthorised');

  const summary = await controlReplies.summariseControlReplies();
  assert.equal(summary.total, 1);
  assert.equal(summary.refused, 1);
});

test('an outcome the schema does not know is refused', { skip: skipWithoutPg() }, async (t) => {
  const { controlReplies } = await setup(t);
  await assert.rejects(() => controlReplies.recordReply({
    chatId: '-100777', replyMessageId: 6100, outcome: 'did_something_clever',
  }));
});

test('an essay is truncated rather than lost', { skip: skipWithoutPg() }, async (t) => {
  const { controlReplies } = await setup(t);
  const row = await controlReplies.recordReply({
    chatId: '-100777', replyMessageId: 6200, outcome: 'no_op', rawText: 'x'.repeat(5000),
  });
  assert.equal(row.rawText.length, 1000);
});

test('only the FIRST answer closes a question', { skip: skipWithoutPg() }, async (t) => {
  const { operationalNotifications } = await setup(t);
  const notice = await operationalNotifications.enqueueNotification({
    noticeKey: 'needs_attention:control_question:12:r0',
    category: 'needs_attention', chatId: '-100777', body: 'Close it?',
    question: { findingId: 12, offeredActions: [] },
  });
  assert.equal(await operationalNotifications.markNoticeAnswered(notice.id, null), true);
  assert.equal(
    await operationalNotifications.markNoticeAnswered(notice.id, null), false,
    'two operators answering at once must not both apply it'
  );
});

test('AN APPROVAL-TIER CORRECTION FROM TELEGRAM PASSES THE CHECK THAT REFUSES THE SYSTEM', {
  skip: skipWithoutPg(),
}, async (t) => {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });

  // The schema's own guard: `system` may only apply tier `auto`. An operator's
  // reply must therefore NOT be attributed to the system — which is the whole
  // reason `initiatorFor` learned a `telegram:` prefix.
  await assert.rejects(() => h.query(
    `INSERT INTO operational_corrections
       (action_key, tier, subject_type, subject_id, old_values, new_values, initiator)
     VALUES ('identity.sync_unit', 'approval', 'group', '49', '{}'::jsonb, '{}'::jsonb, 'system')`
  ), 'the system must not be able to apply an approval-tier correction');

  const ok = await h.query(
    `INSERT INTO operational_corrections
       (action_key, tier, subject_type, subject_id, old_values, new_values, initiator)
     VALUES ('identity.sync_unit', 'approval', 'group', '49', '{}'::jsonb, '{}'::jsonb, $1)
     RETURNING id, initiator`,
    [`telegram:${CREATOR_USER_ID}`]
  );
  assert.equal(ok.rows[0].initiator, `telegram:${CREATOR_USER_ID}`);
});

test('unanswered questions are counted, answered ones are not', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { operationalNotifications: store } = await setup(t);
  assert.equal(await store.countUnansweredQuestions(72), 0);

  const asked = await store.enqueueNotification({
    noticeKey: 'needs_attention:control_question:20:r0',
    category: 'needs_attention', chatId: '-100777', body: 'Close it?',
    question: { findingId: 20, offeredActions: [] },
  });
  await store.enqueueNotification({
    noticeKey: 'needs_attention:control_question:21:r0',
    category: 'needs_attention', chatId: '-100777', body: 'Close it?',
    question: { findingId: 21, offeredActions: [] },
  });
  // A notice that asks nothing is not a question and must not count.
  await store.enqueueNotification({
    noticeKey: 'fuel:group:7',
    category: 'fuel', chatId: '-100777', body: 'Low on fuel',
  });
  assert.equal(await store.countUnansweredQuestions(72), 2);

  await store.markNoticeAnswered(asked.id, null);
  assert.equal(await store.countUnansweredQuestions(72), 1);
});

test('the questions summary distinguishes asked, delivered and answered', {
  skip: skipWithoutPg(),
}, async (t) => {
  // ZERO REPLIES READS THE SAME WHETHER FIVE QUESTIONS WENT UNANSWERED OR NONE
  // WERE EVER SENT. This is the reading that tells those two apart from
  // outside, which is how the control channel is verified in production.
  const { operationalNotifications: store } = await setup(t);
  assert.deepEqual(
    { asked: 0, delivered: 0, answered: 0, outstanding: 0 },
    (({ asked, delivered, answered, outstanding }) => ({ asked, delivered, answered, outstanding }))(
      await store.summariseControlQuestions()
    )
  );

  const one = await store.enqueueNotification({
    noticeKey: 'needs_attention:control_question:30:r0',
    category: 'needs_attention', chatId: '-100777', body: 'Close it?',
    question: { findingId: 30, offeredActions: [] },
  });
  const two = await store.enqueueNotification({
    noticeKey: 'needs_attention:control_question:31:r0',
    category: 'needs_attention', chatId: '-100777', body: 'Close it?',
    question: { findingId: 31, offeredActions: [] },
  });
  // An ordinary notice is not a question and must never be counted as one.
  await store.enqueueNotification({
    noticeKey: 'fuel:group:9', category: 'fuel', chatId: '-100777', body: 'Low',
  });

  // Asked but not yet sent: a question nobody received is not a question asked.
  let summary = await store.summariseControlQuestions();
  assert.equal(summary.asked, 2);
  assert.equal(summary.delivered, 0);

  await store.markNotificationDelivered(one.id, { telegramMessageId: 7001 });
  await store.markNotificationDelivered(two.id, { telegramMessageId: 7002 });
  await store.markNoticeAnswered(one.id, null);

  summary = await store.summariseControlQuestions();
  assert.equal(summary.delivered, 2);
  assert.equal(summary.answered, 1);
  assert.equal(summary.outstanding, 1);
  assert.ok(summary.lastAskedAt);
});

test('the migration is idempotent — it runs on every boot', { skip: skipWithoutPg() }, async (t) => {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'database', 'migrations', '0048_control_channel.sql'), 'utf8'
  );
  await h.query(sql);
  await h.query(sql);
  const operators = await h.query('SELECT COUNT(*)::int AS n FROM control_operators');
  assert.equal(operators.rows[0].n, 1, 'the seed did not duplicate');
  const settings = await h.query('SELECT COUNT(*)::int AS n FROM control_settings');
  assert.equal(settings.rows[0].n, 1);
});
