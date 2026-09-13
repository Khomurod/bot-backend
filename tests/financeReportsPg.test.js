'use strict';

/**
 * The report rows and the period totals, against the real schema.
 *
 * TWO THINGS ONLY POSTGRESQL CAN PROVE:
 *
 *   the once-a-period guarantee is a UNIQUE INDEX, and it is PARTIAL — an
 *   automatic report happens to a period exactly once whatever restarts in
 *   between, while a manual send is a person's deliberate act and they may do
 *   it twice. A test against a stub would prove the stub;
 *
 *   the totals are COUNT/SUM in SQL. Every one of them is a filter or a
 *   boundary, and a half-open period, a NUMERIC coming back as a string, or a
 *   FILTER clause pointing at the wrong column are all things that look fine
 *   in JavaScript and are wrong in the database.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();
const CHAT = '-1001234567890';

const PERIOD_START = new Date('2026-08-31T13:00:00Z');
const PERIOD_END = new Date('2026-09-07T13:00:00Z');

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  return { h, ...h.loadDataLayer(['financeMessages', 'financeDocuments', 'finance/reports']) };
}

/** A captured message with one money code, at `at`. */
async function seedCode(mods, { messageId, at, amount, duplicateReason = null, duplicateOf = null }) {
  const { id } = await mods.financeMessages.captureMessage({
    chatId: CHAT, messageId, text: 'money code', messageDate: at,
  }, { status: 'parsed', parserVersion: 1 });
  const codeId = await mods.financeMessages.recordMoneycode(id, {
    code: `C${messageId}`, codeNormalized: `c${messageId}`,
    amount, parserVersion: 1, issuedAt: at,
    duplicateOfId: duplicateOf, duplicateReason,
  });
  return { messageId: id, codeId };
}

test('the totals count only what is inside the half-open period', { skip: skipWithoutPg() }, async (t) => {
  const m = await setup(t);
  const reports = m['finance/reports'];

  // Exactly on the start: IN. Exactly on the end: OUT. That is what stops a
  // code landing in two reports or in none.
  await seedCode(m, { messageId: 1, at: PERIOD_START, amount: 100 });
  await seedCode(m, { messageId: 2, at: new Date('2026-09-03T00:00:00Z'), amount: 250.25 });
  await seedCode(m, { messageId: 3, at: PERIOD_END, amount: 999 });
  await seedCode(m, { messageId: 4, at: new Date('2026-08-30T00:00:00Z'), amount: 999 });

  const totals = await reports.summariseFinancePeriod({ periodStart: PERIOD_START, periodEnd: PERIOD_END });
  assert.equal(totals.codeCount, 2);
  assert.equal(totals.amountTotal, 350.25);
  assert.equal(typeof totals.amountTotal, 'number', 'NUMERIC comes back as a string unless coerced');
});

test('a code with no amount is counted but not summed', { skip: skipWithoutPg() }, async (t) => {
  const m = await setup(t);
  const reports = m['finance/reports'];
  await seedCode(m, { messageId: 1, at: PERIOD_START, amount: 500 });
  await seedCode(m, { messageId: 2, at: PERIOD_START, amount: null });

  const totals = await reports.summariseFinancePeriod({ periodStart: PERIOD_START, periodEnd: PERIOD_END });
  assert.equal(totals.codeCount, 2);
  assert.equal(totals.codesWithoutAmount, 1);
  assert.equal(totals.amountTotal, 500, 'the report has to be able to say the total is incomplete');
});

test('the two duplicate reasons are counted separately', { skip: skipWithoutPg() }, async (t) => {
  const m = await setup(t);
  const reports = m['finance/reports'];
  const first = await seedCode(m, { messageId: 1, at: PERIOD_START, amount: 500 });
  await seedCode(m, {
    messageId: 2, at: PERIOD_START, amount: 500,
    duplicateOf: first.codeId, duplicateReason: 'same_code',
  });
  await seedCode(m, {
    messageId: 3, at: PERIOD_START, amount: 500,
    duplicateOf: first.codeId, duplicateReason: 'same_amount_recipient_window',
  });

  const totals = await reports.summariseFinancePeriod({ periodStart: PERIOD_START, periodEnd: PERIOD_END });
  assert.equal(totals.duplicateSameCode, 1);
  assert.equal(totals.duplicateSameAmountWindow, 1,
    'a fact and a suspicion must never be summed into one number');
});

test('messages and documents needing a person are counted for the same week',
  { skip: skipWithoutPg() }, async (t) => {
    const m = await setup(t);
    const reports = m['finance/reports'];

    const inside = new Date('2026-09-02T00:00:00Z');
    for (const [i, status] of ['parsed', 'ambiguous', 'unparsed', 'not_moneycode'].entries()) {
      // eslint-disable-next-line no-await-in-loop
      await m.financeMessages.captureMessage(
        { chatId: CHAT, messageId: 100 + i, text: 't', messageDate: inside },
        { status, parserVersion: 1 },
      );
    }
    // A message OUTSIDE the period, with an unreadable status, must not count.
    await m.financeMessages.captureMessage(
      { chatId: CHAT, messageId: 200, text: 't', messageDate: new Date('2026-09-20T00:00:00Z') },
      { status: 'unparsed', parserVersion: 1 },
    );

    // Documents are dated by their MESSAGE, so one read days later still
    // belongs to the week its message was posted in.
    const doc = await m.financeMessages.captureMessage(
      { chatId: CHAT, messageId: 300, text: 'receipt', messageDate: inside },
      { status: 'not_moneycode', parserVersion: 1 },
    );
    for (const [i, status] of ['needs_review', 'failed', 'read'].entries()) {
      // eslint-disable-next-line no-await-in-loop
      const { id } = await m.financeDocuments.enqueueDocument({
        messageRefId: doc.id, chatId: CHAT, messageId: 300, kind: 'document',
        fileId: `f${i}`, fileUniqueId: `u${i}`, mimeType: 'application/pdf', fileSize: 10,
      });
      // eslint-disable-next-line no-await-in-loop
      await m.h.pool.query('UPDATE finance_documents SET status = $2 WHERE id = $1', [id, status]);
    }

    const totals = await reports.summariseFinancePeriod({ periodStart: PERIOD_START, periodEnd: PERIOD_END });
    assert.equal(totals.messageCount, 5);
    assert.equal(totals.messagesNeedingAttention, 2, 'ambiguous and unparsed, and only those');
    assert.equal(totals.documentsNeedingReview, 1);
    assert.equal(totals.documentsFailed, 1);
    assert.equal(totals.documentsRead, 1);
  });

test('a quiet week is zeroes, not nulls', { skip: skipWithoutPg() }, async (t) => {
  const m = await setup(t);
  const totals = await m['finance/reports'].summariseFinancePeriod({
    periodStart: PERIOD_START, periodEnd: PERIOD_END,
  });
  assert.equal(totals.codeCount, 0);
  assert.equal(totals.amountTotal, 0, 'SUM over nothing is NULL — COALESCE is what makes it 0');
  assert.equal(totals.messageCount, 0);
});

test('A PERIOD IS REPORTED AUTOMATICALLY ONCE, whatever restarts in between',
  { skip: skipWithoutPg() }, async (t) => {
    const m = await setup(t);
    const reports = m['finance/reports'];
    const row = {
      periodStart: PERIOD_START, periodEnd: PERIOD_END, scheduledFor: PERIOD_END,
      status: 'sent', chatId: CHAT, totals: { codeCount: 1 }, body: 'x', sentAt: new Date(),
    };

    const first = await reports.recordReport(row);
    assert.equal(first.created, true);

    // The redeploy case: the same period, again.
    const second = await reports.recordReport(row);
    assert.equal(second.created, false, 'two reports in one morning is the failure this prevents');

    // And a period reported once must not become reportable by changing status.
    const asFailed = await reports.recordReport({ ...row, status: 'failed' });
    assert.equal(asFailed.created, false);

    const { rows } = await m.h.pool.query(
      "SELECT COUNT(*)::int AS n FROM finance_reports WHERE status <> 'manual'",
    );
    assert.equal(rows[0].n, 1);
  });

test('a MANUAL send is a person\'s act and may happen twice', { skip: skipWithoutPg() }, async (t) => {
  const m = await setup(t);
  const reports = m['finance/reports'];
  const row = {
    periodStart: PERIOD_START, periodEnd: PERIOD_END, scheduledFor: PERIOD_END,
    status: 'manual', chatId: CHAT, body: 'x', sentAt: new Date(),
  };

  assert.equal((await reports.recordReport(row)).created, true);
  assert.equal((await reports.recordReport(row)).created, true,
    'refusing the second would be the tool arguing with its operator');

  // And a manual send does not consume the automatic slot for that period.
  assert.equal((await reports.recordReport({ ...row, status: 'sent' })).created, true);
});

test('a suppressed backfill is a ROW, because no row looks like a job that never ran',
  { skip: skipWithoutPg() }, async (t) => {
    const m = await setup(t);
    const reports = m['finance/reports'];
    await reports.recordReport({
      periodStart: PERIOD_START, periodEnd: PERIOD_END, scheduledFor: PERIOD_END,
      status: 'suppressed_backfill', chatId: CHAT, totals: null, body: null,
      error: 'the Finance Monitor was not watching for all of this period',
    });

    const found = await reports.findReportForPeriod(PERIOD_START);
    assert.equal(found.status, 'suppressed_backfill');
    assert.equal(found.sentAt, null);
  });

test('the schema refuses a status nobody handles and a period that runs backwards',
  { skip: skipWithoutPg() }, async (t) => {
    const { h } = await setup(t);
    await assert.rejects(
      () => h.pool.query(
        `INSERT INTO finance_reports (period_start, period_end, scheduled_for, status)
         VALUES ($1,$2,$2,'probably_fine')`, [PERIOD_START, PERIOD_END],
      ),
      /finance_reports_status/,
    );
    await assert.rejects(
      () => h.pool.query(
        `INSERT INTO finance_reports (period_start, period_end, scheduled_for, status)
         VALUES ($2,$1,$1,'sent')`, [PERIOD_START, PERIOD_END],
      ),
      /finance_reports_period_order/,
    );
  });

test('the list is newest first and never returns the body', { skip: skipWithoutPg() }, async (t) => {
  const m = await setup(t);
  const reports = m['finance/reports'];
  for (const [i, week] of [0, 1, 2].entries()) {
    const start = new Date(PERIOD_START.getTime() + week * 7 * 86400000);
    // eslint-disable-next-line no-await-in-loop
    await reports.recordReport({
      periodStart: start, periodEnd: new Date(start.getTime() + 7 * 86400000),
      scheduledFor: new Date(start.getTime() + 7 * 86400000),
      status: 'sent', chatId: CHAT, totals: { codeCount: i }, body: 'secret body', sentAt: new Date(),
    });
  }

  const list = await reports.listReports({ limit: 10 });
  assert.equal(list.length, 3);
  assert.ok(list[0].scheduledFor > list[1].scheduledFor);
  assert.ok(!JSON.stringify(list).includes('secret body'),
    'the body is payment text and is read on its own screen, not in a list');
});
