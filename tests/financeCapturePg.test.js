'use strict';

/**
 * The capture store against the real schema.
 *
 * Everything proved here lives in SQL or in the argument between the SQL and
 * the module, so no stub can stand in for it:
 *
 *   idempotency is the DATABASE's, not a check-then-insert — Telegram
 *   redelivers and a restart replays, and two racing handlers cannot both win
 *   a unique index. A test with a stubbed store would prove the stub;
 *
 *   the money-code CHECKs are the last line between a duplicate claim and a
 *   nonsense one: a reason without the row it names, a row repeating itself,
 *   a negative amount;
 *
 *   `findDuplicateCandidates` is one statement with two OR'd branches and a
 *   window. Whether the window actually excludes anything is a property of the
 *   SQL, and getting it wrong would mean silently calling everything a
 *   duplicate — or nothing.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();

const CHAT = '-1001234567890';

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  return { h, ...h.loadDataLayer(['financeMessages']) };
}

function message(messageId, over = {}) {
  return {
    chatId: CHAT,
    messageId,
    senderUserId: 111,
    senderUsername: 'poster',
    senderName: 'A Poster',
    text: 'money code 1234 5678 9012 $500',
    hasDocument: false,
    hasPhoto: false,
    mediaGroupId: null,
    messageDate: new Date('2026-09-01T12:00:00Z'),
    editDate: null,
    ...over,
  };
}

const PARSED = {
  status: 'parsed', parserVersion: 1, code: '1234 5678 9012',
  codeNormalized: '123456789012', amount: 500, currency: 'USD',
};

test('a redelivered message is stored once and reports the same row', { skip: skipWithoutPg() }, async (t) => {
  const { h, financeMessages } = await setup(t);

  const first = await financeMessages.captureMessage(message(10), PARSED);
  assert.equal(first.created, true);

  // What Telegram does after a restart. The second call must not be a second
  // row, and it must still hand back the id so the caller can go on working.
  const second = await financeMessages.captureMessage(message(10), PARSED);
  assert.equal(second.created, false);
  assert.equal(String(second.id), String(first.id));

  const { rows } = await h.pool.query(
    'SELECT COUNT(*)::int AS n FROM finance_messages WHERE chat_id = $1 AND message_id = 10', [CHAT],
  );
  assert.equal(rows[0].n, 1);
});

test('the verbatim text survives, and the parse sits beside it', { skip: skipWithoutPg() }, async (t) => {
  const { h, financeMessages } = await setup(t);
  const raw = 'MONEY CODE 4444 3333 2222 for $250  — thanks';

  await financeMessages.captureMessage(message(11, { text: raw }), PARSED);

  const { rows } = await h.pool.query(
    'SELECT text, parse_status, parser_version, parse_json FROM finance_messages WHERE message_id = 11',
  );
  // The point of the table: a tightened parser must be able to re-read exactly
  // what the provisional one saw.
  assert.equal(rows[0].text, raw);
  assert.equal(rows[0].parse_status, 'parsed');
  assert.equal(rows[0].parser_version, 1);
  assert.equal(rows[0].parse_json.codeNormalized, '123456789012');
});

test('an edit replaces the text and re-reads it; an edit of nothing is nothing', { skip: skipWithoutPg() }, async (t) => {
  const { h, financeMessages } = await setup(t);

  const { id } = await financeMessages.captureMessage(message(12), PARSED);
  const before = await h.pool.query('SELECT captured_at FROM finance_messages WHERE id = $1', [id]);

  const updated = await financeMessages.applyEdit(CHAT, 12, 'money code 9999 8888 7777 $50', {
    status: 'parsed', parserVersion: 1, codeNormalized: '999988887777',
  });
  assert.equal(String(updated), String(id));

  const after = await h.pool.query(
    'SELECT text, edit_date, captured_at, parse_json FROM finance_messages WHERE id = $1', [id],
  );
  assert.match(after.rows[0].text, /9999 8888 7777/);
  assert.notEqual(after.rows[0].edit_date, null);
  // When Wenze FIRST saw it is a different fact from when the group last
  // changed it, and editing must not overwrite the first.
  assert.deepEqual(after.rows[0].captured_at, before.rows[0].captured_at);

  // An edit to a message that was never captured (posted before the monitor was
  // switched on) must not conjure a row out of an edit.
  assert.equal(await financeMessages.applyEdit(CHAT, 9999, 'x', { status: 'unparsed', parserVersion: 1 }), null);
  const count = await h.pool.query('SELECT COUNT(*)::int AS n FROM finance_messages');
  assert.equal(count.rows[0].n, 1);
});

test('re-reading a message cannot double-count the code it already yielded', { skip: skipWithoutPg() }, async (t) => {
  const { h, financeMessages } = await setup(t);
  const { id } = await financeMessages.captureMessage(message(13), PARSED);

  const fields = {
    code: '1234 5678 9012', codeNormalized: '123456789012', amount: 500,
    currency: 'USD', parserVersion: 1, issuedAt: new Date('2026-09-01T12:00:00Z'),
  };
  const firstCode = await financeMessages.recordMoneycode(id, fields);
  assert.ok(firstCode);
  assert.equal(await financeMessages.recordMoneycode(id, fields), null);

  const { rows } = await h.pool.query('SELECT COUNT(*)::int AS n FROM finance_moneycodes');
  assert.equal(rows[0].n, 1);
});

test('the duplicate CHECKs refuse a claim that does not hold together', { skip: skipWithoutPg() }, async (t) => {
  const { h, financeMessages } = await setup(t);
  const { id } = await financeMessages.captureMessage(message(14), PARSED);

  // Each insert needs its own code_normalized: (message_ref_id, code_normalized)
  // is unique, and a unique violation would look exactly like the CHECK firing.
  let n = 0;
  const insert = (duplicateOfId, reason) => {
    n += 1;
    return h.pool.query(
      `INSERT INTO finance_moneycodes
         (message_ref_id, code, code_normalized, amount, currency, parser_version,
          duplicate_of_id, duplicate_reason)
       VALUES ($1,$2,$2,500,'USD',1,$3,$4) RETURNING id`,
      [id, `code-${n}`, duplicateOfId, reason],
    );
  };

  // A reason with no row it points at is an accusation with no subject.
  await assert.rejects(() => insert(null, 'same_code'), /finance_moneycodes_duplicate_pair/);

  const anchor = await insert(null, null);
  // And a pointer with no reason cannot say WHICH claim is being made —
  // 'same_code' is a fact, 'same_amount_recipient_window' is a suspicion, and
  // the weekly report has to be able to tell them apart.
  await assert.rejects(() => insert(anchor.rows[0].id, null), /finance_moneycodes_duplicate_pair/);

  await assert.rejects(() => insert(anchor.rows[0].id, 'guessing'), /finance_moneycodes_duplicate_reason/);

  await assert.rejects(
    () => h.pool.query(
      `INSERT INTO finance_moneycodes (message_ref_id, code, code_normalized, amount, parser_version)
       VALUES ($1,'neg','neg',-1,1)`, [id],
    ),
    /finance_moneycodes_amount_positive/,
  );
});

test('a money code cannot be recorded as repeating itself', { skip: skipWithoutPg() }, async (t) => {
  const { h, financeMessages } = await setup(t);
  const { id } = await financeMessages.captureMessage(message(15), PARSED);
  const codeId = await financeMessages.recordMoneycode(id, {
    code: 'a', codeNormalized: 'a', amount: 100, parserVersion: 1,
  });

  await assert.rejects(
    () => h.pool.query(
      'UPDATE finance_moneycodes SET duplicate_of_id = id, duplicate_reason = $2 WHERE id = $1',
      [codeId, 'same_code'],
    ),
    /finance_moneycodes_not_self/,
  );
});

test('the candidate query matches an exact code always, and an amount only inside the window',
  { skip: skipWithoutPg() }, async (t) => {
    const { financeMessages } = await setup(t);
    const { id } = await financeMessages.captureMessage(message(16), PARSED);

    const old = new Date('2026-01-01T00:00:00Z');
    const recent = new Date('2026-09-01T09:00:00Z');
    await financeMessages.recordMoneycode(id, {
      code: 'OLD', codeNormalized: 'oldcode', amount: 500, parserVersion: 1,
      issuedTo: 'A Driver', issuedToNormalized: 'adriver', issuedAt: old,
    });
    await financeMessages.recordMoneycode(id, {
      code: 'RECENT', codeNormalized: 'recentcode', amount: 500, parserVersion: 1,
      issuedTo: 'A Driver', issuedToNormalized: 'adriver', issuedAt: recent,
    });

    const since = new Date('2026-08-30T00:00:00Z');

    // The amount branch respects the window: the January row is out.
    const byAmount = await financeMessages.findDuplicateCandidates({
      codeNormalized: 'nothing-like-this', amount: 500, since,
    });
    assert.deepEqual(byAmount.map((r) => r.codeNormalized), ['recentcode']);
    assert.equal(byAmount[0].amount, 500, 'NUMERIC must come back as a number, not a string');

    // The code branch does NOT: a money code is spendable whenever it was
    // issued, so an exact repeat is a duplicate however old the first one is.
    const byCode = await financeMessages.findDuplicateCandidates({
      codeNormalized: 'oldcode', amount: null, since,
    });
    assert.deepEqual(byCode.map((r) => r.codeNormalized), ['oldcode']);
  });

test('the summary counts by status and counts duplicates', { skip: skipWithoutPg() }, async (t) => {
  const { financeMessages } = await setup(t);

  await financeMessages.captureMessage(message(20), PARSED);
  await financeMessages.captureMessage(message(21, { text: 'good morning' }), { status: 'not_moneycode', parserVersion: 1 });
  await financeMessages.captureMessage(message(22, { text: 'money code?' }), { status: 'unparsed', parserVersion: 1 });
  const amb = await financeMessages.captureMessage(message(23, { text: 'codes 1111 and 2222' }), { status: 'ambiguous', parserVersion: 1 });

  const firstCode = await financeMessages.recordMoneycode(amb.id, {
    code: 'a', codeNormalized: 'aaa', amount: 10, parserVersion: 1,
  });
  await financeMessages.recordMoneycode(amb.id, {
    code: 'b', codeNormalized: 'bbb', amount: 10, parserVersion: 1,
    duplicateOfId: firstCode, duplicateReason: 'same_amount_recipient_window',
  });

  const summary = await financeMessages.summariseCapture();
  assert.equal(summary.available, true);
  assert.equal(summary.total, 4);
  assert.deepEqual(summary.byStatus, { parsed: 1, not_moneycode: 1, unparsed: 1, ambiguous: 1 });
  assert.equal(summary.codes, 2);
  assert.equal(summary.duplicates, 1);
});
