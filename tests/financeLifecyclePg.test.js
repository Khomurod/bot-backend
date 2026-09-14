'use strict';

/**
 * The life of a money code, against the real schema.
 *
 * WHY THIS CANNOT BE A UNIT TEST. Three of the properties below live in SQL and
 * nowhere else, so a stubbed store would prove the stub:
 *
 *   voiding is idempotent because of a `WHERE status <> 'voided'`, which is
 *   what makes a Telegram redelivery, a re-read and two racing passes all
 *   harmless;
 *
 *   re-reading a message must not resurrect a voided code — the guard is a
 *   CASE inside the UPDATE, and getting it wrong would bring dead money back
 *   to life every time the parser changed;
 *
 *   the totals that exclude voided amounts are FILTER clauses. Whether they
 *   actually exclude anything is a property of the statement.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();
const CHAT = '-1009876543210';

/** The live EFS format, anonymised. */
function efs(code, amount = '480.00') {
  return [
    `Money Transfer code: ${code}`,
    'Report Reference: 165373918',
    `Amount: ${amount}`,
    'Issued to: WENZE INVESTMENTS LLC',
    'Notes: B-1 911 BRHANE GEBRU',
  ].join('\n');
}

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const layers = h.loadDataLayer(['financeMessages', 'financeMoneycodeLifecycle', 'finance/reports']);
  // The harness keys each module by the literal name it was asked for, and
  // these must come from IT rather than a plain require — a direct require
  // binds the real pool, which has no database behind it here.
  return {
    h,
    financeMessages: layers.financeMessages,
    life: layers.financeMoneycodeLifecycle,
    reports: layers['finance/reports'],
  };
}

function message(messageId, text, over = {}) {
  return {
    chatId: CHAT,
    messageId,
    senderUserId: 111,
    senderUsername: 'poster',
    senderName: 'A Poster',
    text,
    hasDocument: false,
    hasPhoto: false,
    mediaGroupId: null,
    messageDate: new Date('2026-09-10T12:00:00Z'),
    editDate: null,
    ...over,
  };
}

/** Capture a message and record whatever the parser read out of it. */
async function issue(financeMessages, messageId, code, over = {}) {
  const { parseMoneycodeMessage } = require('../lib/finance/moneycode');
  const text = over.text || efs(code, over.amount || '480.00');
  const parsed = parseMoneycodeMessage(text);
  const { id } = await financeMessages.captureMessage(message(messageId, text, over), parsed);
  const codeId = parsed.codeNormalized
    ? await financeMessages.recordMoneycode(id, {
      code: parsed.code,
      codeNormalized: parsed.codeNormalized,
      amount: parsed.amount,
      currency: parsed.currency,
      reportReference: parsed.reportReference,
      notes: parsed.notes,
      issuedTo: parsed.issuedTo,
      issuedToNormalized: (parsed.issuedTo || '').toLowerCase(),
      senderUserId: 111,
      senderName: 'A Poster',
      issuedAt: over.messageDate || new Date('2026-09-10T12:00:00Z'),
      parserVersion: parsed.parserVersion,
      ...(over.duplicate || {}),
    })
    : null;
  return { messageRefId: id, codeId, parsed };
}

test('the production format is stored with every field it names',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, financeMessages } = await setup(t);
    const { codeId } = await issue(financeMessages, 5001, '1491583146');
    assert.ok(codeId, 'the message that used to read as not_moneycode now records a code');

    const { rows } = await h.query(
      `SELECT code_normalized, report_reference, amount, issued_to, notes, status
         FROM finance_moneycodes WHERE id = $1`, [codeId],
    );
    assert.equal(rows[0].code_normalized, '1491583146');
    assert.equal(rows[0].report_reference, '165373918', 'the reference is kept, and is not a code');
    assert.equal(Number(rows[0].amount), 480);
    assert.equal(rows[0].issued_to, 'WENZE INVESTMENTS LLC');
    assert.equal(rows[0].status, 'active');
  });

test('voiding is idempotent, and keeps the evidence of the FIRST void',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, financeMessages, life } = await setup(t);
    const { codeId } = await issue(financeMessages, 5002, '1491583146');

    const first = await life.voidCode(codeId, {
      confidence: 95, evidence: { kind: 'named' }, at: new Date('2026-09-10T13:00:00Z'),
    });
    const second = await life.voidCode(codeId, {
      confidence: 80, evidence: { kind: 'only_active_code_in_scope' },
    });

    assert.equal(first.changed, true);
    assert.equal(second.changed, false, 'a redelivery cannot void the same code twice');

    const { rows } = await h.query(
      'SELECT status, void_confidence, void_evidence, voided_at FROM finance_moneycodes WHERE id = $1',
      [codeId],
    );
    assert.equal(rows[0].status, 'voided');
    assert.equal(rows[0].void_confidence, 95, 'the weaker later evidence did not overwrite it');
    assert.equal(rows[0].void_evidence.kind, 'named');
    assert.ok(rows[0].voided_at);

    const events = await life.listEvents(codeId);
    assert.equal(events.filter((e) => e.event === 'voided').length, 1, 'one void, one event');
  });

test('nothing is deleted: a voided code keeps its digits, amount and message',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, financeMessages, life } = await setup(t);
    const { codeId, messageRefId } = await issue(financeMessages, 5003, '1491583146');
    await life.voidCode(codeId, { messageRefId, confidence: 95 });

    const { rows } = await h.query(
      `SELECT c.code_normalized, c.amount, c.issued_at, m.text
         FROM finance_moneycodes c JOIN finance_messages m ON m.id = c.message_ref_id
        WHERE c.id = $1`, [codeId],
    );
    assert.equal(rows[0].code_normalized, '1491583146');
    assert.equal(Number(rows[0].amount), 480);
    assert.ok(rows[0].issued_at);
    assert.match(rows[0].text, /Money Transfer code/, 'the original message is untouched');
  });

/** The one that would quietly resurrect dead money. */
test('re-reading a voided code does NOT bring it back to life',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, financeMessages, life } = await setup(t);
    const { codeId, messageRefId, parsed } = await issue(financeMessages, 5004, '1491583146');
    await life.voidCode(codeId, { confidence: 95 });

    await financeMessages.updateMoneycodeInterpretation(messageRefId, '1491583146', {
      code: parsed.code, amount: 480, currency: 'USD', parserVersion: 99,
    });

    const { rows } = await h.query('SELECT status FROM finance_moneycodes WHERE id = $1', [codeId]);
    assert.equal(rows[0].status, 'voided', 'a fresher READING is not a fresher STATE');
  });

test('the same code posted twice is one code and one repeat, never two issues',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, financeMessages } = await setup(t);
    const first = await issue(financeMessages, 5005, '1491583146');
    // A REASON MUST NAME THE ROW IT REPEATS — a pre-existing CHECK, and a good
    // one: "this is a duplicate of nothing" is not a claim anybody can audit.
    await issue(financeMessages, 5006, '1491583146', {
      duplicate: { duplicateOfId: first.codeId, duplicateReason: 'same_code' },
    });

    const { rows } = await h.query(
      `SELECT status, COUNT(*)::int AS n FROM finance_moneycodes
        WHERE code_normalized = '1491583146' GROUP BY status ORDER BY status`,
    );
    const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.n]));
    assert.equal(byStatus.active, 1, 'one issue');
    assert.equal(byStatus.duplicate_posting, 1, 'and one posting of it, recorded as such');
  });

test('a voided amount leaves the ACTIVE total and stays in the history',
  { skip: skipWithoutPg() }, async (t) => {
    const { financeMessages, life, reports } = await setup(t);

    const a = await issue(financeMessages, 5007, '1491583146');
    await issue(financeMessages, 5008, '2288341907', { amount: '300.00' });
    await life.voidCode(a.codeId, { confidence: 95 });

    const totals = await reports.summariseFinancePeriod({
      periodStart: new Date('2026-09-08T00:00:00Z'),
      periodEnd: new Date('2026-09-15T00:00:00Z'),
    });

    assert.equal(totals.codeCount, 2, 'both were issued, and both are still counted as issued');
    assert.equal(Number(totals.activeAmount), 300, 'the voided 480 is not active money');
    assert.equal(Number(totals.voidedAmount), 480, 'and it is still reported, not erased');
    assert.equal(totals.voidedCount, 1);
    assert.equal(totals.activeCount, 1);
  });

test('a replacement is recorded only with the code it points at',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, financeMessages, life } = await setup(t);
    const a = await issue(financeMessages, 5009, '1491583146');
    const b = await issue(financeMessages, 5010, '2288341907');

    assert.equal((await life.markReplaced(a.codeId, a.codeId)).changed, false,
      'a code cannot replace itself');
    assert.equal((await life.markReplaced(a.codeId, b.codeId, { evidence: { kind: 'named' } })).changed, true);

    const { rows } = await h.query(
      'SELECT status, replaced_by_id FROM finance_moneycodes WHERE id = $1', [a.codeId],
    );
    assert.equal(rows[0].status, 'replaced');
    assert.equal(Number(rows[0].replaced_by_id), Number(b.codeId));
  });

test('the schema refuses a void with no time and a replacement pointing nowhere',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, financeMessages } = await setup(t);
    const { codeId } = await issue(financeMessages, 5011, '1491583146');

    await assert.rejects(
      () => h.query("UPDATE finance_moneycodes SET status = 'voided', voided_at = NULL WHERE id = $1", [codeId]),
      /finance_moneycodes_voided_pair/,
      'a void that cannot say when cannot be reported by period',
    );
    await assert.rejects(
      () => h.query("UPDATE finance_moneycodes SET status = 'replaced' WHERE id = $1", [codeId]),
      /finance_moneycodes_replaced_pair/,
    );
  });

test('the reply relationship is captured, which is what a void points through',
  { skip: skipWithoutPg() }, async (t) => {
    const { financeMessages, life } = await setup(t);
    const issued = await issue(financeMessages, 5012, '1491583146');

    const { parseMoneycodeMessage } = require('../lib/finance/moneycode');
    const voidText = 'voided';
    await financeMessages.captureMessage(
      message(5013, voidText, { replyToMessageId: 5012 }),
      parseMoneycodeMessage(voidText),
    );

    const found = await life.findCodeByMessage(CHAT, 5012);
    assert.equal(Number(found.id), Number(issued.codeId),
      'the replied-to message resolves to the code it issued');
  });

test('a code is found by the digits a message named, and never by a near miss',
  { skip: skipWithoutPg() }, async (t) => {
    const { financeMessages, life } = await setup(t);
    const issued = await issue(financeMessages, 5014, '1491583146');

    const exact = await life.findCodeByDigits('1491583146');
    assert.equal(Number(exact.id), Number(issued.codeId));
    assert.equal(exact.status, 'active');

    // THE DANGEROUS ONE. A substring of a real code is a DIFFERENT payment, and
    // a lookup that stretched to reach it would be the model-invented match the
    // whole reading path refuses.
    assert.equal(await life.findCodeByDigits('4915831'), null, 'a substring is not this code');
    assert.equal(await life.findCodeByDigits('14915831460'), null, 'nor is a longer run');
    assert.equal(await life.findCodeByDigits(''), null);
    assert.equal(await life.findCodeByDigits(null), null);

    // Written with spaces is the same code written differently, not another one.
    const spaced = await life.findCodeByDigits('1491 5831 46');
    assert.equal(Number(spaced.id), Number(issued.codeId));
  });

test('every transition leaves an event saying who decided it',
  { skip: skipWithoutPg() }, async (t) => {
    const { financeMessages, life } = await setup(t);
    const { codeId, messageRefId } = await issue(financeMessages, 5015, '1491583146');

    assert.deepEqual(await life.listEvents(codeId), [], 'nothing has happened to it yet');

    await life.markNeedsReview(codeId, 'a model read a message as voiding this code', {
      messageRefId, decidedBy: 'ai', evidence: { kind: 'ai_reading', confidence: 82 },
    });
    await life.voidCode(codeId, {
      messageRefId, confidence: 95, decidedBy: 'deterministic', evidence: { kind: 'named' },
    });

    const events = await life.listEvents(codeId);
    assert.equal(events.length, 2, 'both transitions are on the record');
    assert.equal(events[0].event, 'voided', 'newest first');
    assert.equal(events[0].decidedBy, 'deterministic');
    assert.equal(events[0].confidence, 95);
    assert.equal(events[1].event, 'needs_review');
    assert.equal(events[1].decidedBy, 'ai',
      'a reading a model contributed to is never indistinguishable from a rule');
    assert.equal(events[1].note, 'a model read a message as voiding this code');
    assert.deepEqual(events[1].evidence, { kind: 'ai_reading', confidence: 82 });
  });

/**
 * VOID THEN RE-ISSUE IS THE COMMONEST STORY THERE IS, and both facts are true
 * of the same code while the status column can hold only one. It keeps the
 * stronger, earlier statement about the money. Letting `replaced` win would
 * shrink the voided total on every report — the number somebody is reconciling
 * against — while the relationship it gained is already in its own column.
 */
test('a replacement does NOT overwrite a void, and the report still sees both',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, financeMessages, life, reports } = await setup(t);
    const a = await issue(financeMessages, 5016, '1491583146');
    const b = await issue(financeMessages, 5017, '2288341907', { amount: '300.00' });

    await life.voidCode(a.codeId, { confidence: 95, evidence: { kind: 'named' } });
    const out = await life.markReplaced(a.codeId, b.codeId, { evidence: { kind: 'named' } });

    assert.equal(out.changed, true);
    assert.equal(out.status, 'voided', 'the void stands');

    const { rows } = await h.query(
      'SELECT status, voided_at, replaced_by_id FROM finance_moneycodes WHERE id = $1', [a.codeId],
    );
    assert.equal(rows[0].status, 'voided');
    assert.ok(rows[0].voided_at, 'and it still says when');
    assert.equal(Number(rows[0].replaced_by_id), Number(b.codeId),
      'the relationship is recorded all the same');

    const totals = await reports.summariseFinancePeriod({
      periodStart: new Date('2026-09-08T00:00:00Z'),
      periodEnd: new Date('2026-09-15T00:00:00Z'),
    });
    assert.equal(totals.voidedCount, 1, 'still reported as voided');
    assert.equal(Number(totals.voidedAmount), 480);
    assert.equal(totals.replacedCount, 1, 'AND as superseded — two facts, not a partition');
    assert.equal(Number(totals.activeAmount), 300, 'only the live code is active money');

    // Idempotent: pointing it at the same replacement again changes nothing.
    assert.equal((await life.markReplaced(a.codeId, b.codeId)).changed, false);
    const events = await life.listEvents(a.codeId);
    assert.equal(events.filter((e) => e.event === 'replaced').length, 1);
  });

/**
 * A CODE WAITING ON A PERSON IS STILL MONEY THE COMPANY IS OUT.
 *
 * `needs_review` means an ambiguous void or replacement nobody has settled — it
 * does NOT mean the code was voided. Excluding it from the active total made
 * real outstanding money vanish from the report at precisely the moment
 * somebody needed to look at it, and contradicted LIVE_STATUSES in this
 * module's own header.
 */
test('a code needing a person stays in the ACTIVE total until somebody settles it',
  { skip: skipWithoutPg() }, async (t) => {
    const { financeMessages, life, reports } = await setup(t);
    const a = await issue(financeMessages, 5018, '1491583146');
    await issue(financeMessages, 5019, '2288341907', { amount: '300.00' });

    await life.markNeedsReview(a.codeId, 'a void nobody could match to a code');

    const totals = await reports.summariseFinancePeriod({
      periodStart: new Date('2026-09-08T00:00:00Z'),
      periodEnd: new Date('2026-09-15T00:00:00Z'),
    });

    assert.equal(Number(totals.activeAmount), 780,
      'the unsettled 480 is still money that went out');
    assert.equal(totals.activeCount, 2);
    assert.equal(totals.codesNeedingReview, 1, 'and it is counted as needing a person too');
    assert.equal(totals.voidedCount, 0, 'nobody has voided anything');

    const capture = await financeMessages.summariseCapture();
    assert.equal(capture.active, 2, 'the settings screen agrees');
    assert.equal(capture.needsReview, 1);
  });

/**
 * THE FIRST DEPLOY IS WHERE THIS SHOWS.
 *
 * Every pre-existing row defaults to `active` when the column is added,
 * including repeats the duplicate decision had already flagged. New repeats are
 * stored as `duplicate_posting` and stay out of the active total, so without a
 * backfill the two vocabularies disagree immediately: the total claims the
 * company is out money for a code it was only ever told about twice.
 */
test('the migration moves ALREADY-FLAGGED repeats out of the active total',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, financeMessages, reports } = await setup(t);
    const first = await issue(financeMessages, 5020, '1491583146');
    const second = await issue(financeMessages, 5021, '1491583146');

    // Put the second row back the way a pre-migration installation held it:
    // flagged as a repeat, but with the status the column defaults to.
    await h.query(
      `UPDATE finance_moneycodes
          SET status = 'active', duplicate_of_id = $2, duplicate_reason = 'same_code'
        WHERE id = $1`,
      [second.codeId, first.codeId],
    );

    let totals = await reports.summariseFinancePeriod({
      periodStart: new Date('2026-09-08T00:00:00Z'),
      periodEnd: new Date('2026-09-15T00:00:00Z'),
    });
    assert.equal(Number(totals.activeAmount), 960, 'this is the double count');

    // AND THE MIGRATION ACTUALLY CARRIES IT. A correct statement that lives
    // only in a test fixes nothing on the deploy this was written for.
    const migration = require('node:fs').readFileSync(
      require('node:path').resolve(__dirname, '../database/migrations/0057_finance_moneycode_lifecycle.sql'),
      'utf8',
    );
    assert.match(migration, /UPDATE finance_moneycodes\s+SET status = 'duplicate_posting'/);
    assert.match(migration, /WHERE duplicate_reason = 'same_code'/);

    // The migration's backfill, verbatim, and run twice to prove it settles.
    for (let i = 0; i < 2; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await h.query(
        `UPDATE finance_moneycodes SET status = 'duplicate_posting'
          WHERE duplicate_reason = 'same_code' AND status = 'active'`,
      );
    }

    totals = await reports.summariseFinancePeriod({
      periodStart: new Date('2026-09-08T00:00:00Z'),
      periodEnd: new Date('2026-09-15T00:00:00Z'),
    });
    assert.equal(Number(totals.activeAmount), 480, 'one code, one debt');
    assert.equal(totals.duplicatePostings, 1);
    assert.equal(totals.activeCount, 1);
  });
