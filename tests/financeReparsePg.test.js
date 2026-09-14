'use strict';

/**
 * Re-reading what an older parser misunderstood, against the real schema.
 *
 * THE SITUATION THIS EXISTS FOR IS LIVE. Production captured the company's EFS
 * messages while version 1 was running, and version 1 answered `not_moneycode`
 * — it had never heard of "Money Transfer code". Those rows are sitting there
 * now with real money in them and nothing would ever look at them again, so a
 * parser fix without this pass fixes only the future.
 *
 * THE TWO PROPERTIES THAT MATTER. It must actually find and re-read them, and
 * running it repeatedly must not produce a second money-code row for the same
 * reading — a payments table that double-counts on a retry is worse than one
 * that missed the message.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');
const { PARSER_VERSION } = require('../lib/finance/moneycode');

const ALL_MIGRATIONS = allMigrationsSql();
const CHAT = '-1005555555555';

const EFS = [
  'Money Transfer code: 1491583146',
  'Report Reference: 165373918',
  'Amount: 480.00',
  'Issued to: WENZE INVESTMENTS LLC',
  'Notes: B-1 911 BRHANE GEBRU',
].join('\n');

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const layers = h.loadDataLayer(['financeMessages']);
  return { h, financeMessages: layers.financeMessages };
}

/**
 * A row exactly as version 1 left it: the real text, and the verdict the old
 * parser reached — captured by writing it directly, because the point is to
 * reproduce the state production is in, not to re-derive it.
 */
async function captureAsVersion1(h, messageId, text) {
  const { rows } = await h.query(
    `INSERT INTO finance_messages (
       chat_id, message_id, sender_name, text, message_date,
       parse_status, parser_version, parse_json
     ) VALUES ($1,$2,'A Poster',$3,'2026-09-10T12:00:00Z','not_moneycode',1,
       '{"status":"not_moneycode","parserVersion":1}'::jsonb)
     RETURNING id`,
    [CHAT, messageId, text],
  );
  return rows[0].id;
}

test('the backlog an older parser left behind is found',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, financeMessages } = await setup(t);
    await captureAsVersion1(h, 6001, EFS);
    await captureAsVersion1(h, 6002, 'morning all');

    assert.equal(await financeMessages.countStaleParserMessages(PARSER_VERSION), 2);
    const ids = await financeMessages.listStaleParserMessages({ version: PARSER_VERSION, limit: 10 });
    assert.equal(ids.length, 2, 'both were read by version 1 and neither has been revisited');
  });

test('re-reading turns the real production message into a money code',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, financeMessages } = await setup(t);
    const id = await captureAsVersion1(h, 6003, EFS);

    const out = await financeMessages.reparseMessage(id);

    assert.equal(out.before, 'not_moneycode', 'this is exactly what production holds');
    assert.equal(out.after, 'parsed');
    assert.equal(out.parsed.codeNormalized, '1491583146');
    assert.equal(out.parsed.amount, 480);

    const { rows } = await h.query('SELECT parser_version, parse_status FROM finance_messages WHERE id = $1', [id]);
    assert.equal(rows[0].parser_version, PARSER_VERSION, 'and it will not be re-read again for nothing');
    assert.equal(rows[0].parse_status, 'parsed');
  });

/** Running the pass twice must not double-count anybody's money. */
test('re-reading repeatedly records the code ONCE',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, financeMessages } = await setup(t);
    const id = await captureAsVersion1(h, 6004, EFS);

    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const out = await financeMessages.reparseMessage(id);
      // eslint-disable-next-line no-await-in-loop
      const written = await financeMessages.recordMoneycode(id, {
        code: out.parsed.code,
        codeNormalized: out.parsed.codeNormalized,
        amount: out.parsed.amount,
        currency: 'USD',
        reportReference: out.parsed.reportReference,
        notes: out.parsed.notes,
        issuedTo: out.parsed.issuedTo,
        issuedAt: new Date('2026-09-10T12:00:00Z'),
        parserVersion: out.parsed.parserVersion,
      });
      if (i > 0) assert.equal(written, null, 'the second and third attempts record nothing');
    }

    const { rows } = await h.query(
      "SELECT COUNT(*)::int AS n FROM finance_moneycodes WHERE code_normalized = '1491583146'",
    );
    assert.equal(rows[0].n, 1, 'one message, one code, however many times it is re-read');
  });

test('ordinary chat re-reads as ordinary chat and creates nothing',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, financeMessages } = await setup(t);
    const id = await captureAsVersion1(h, 6005, 'is the truck loaded yet');

    const out = await financeMessages.reparseMessage(id);
    assert.equal(out.after, 'not_moneycode');

    const { rows } = await h.query('SELECT COUNT(*)::int AS n FROM finance_moneycodes');
    assert.equal(rows[0].n, 0);
  });

test('a message the current parser already read is not in the backlog',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, financeMessages } = await setup(t);
    const id = await captureAsVersion1(h, 6006, EFS);
    await financeMessages.reparseMessage(id);

    assert.equal(await financeMessages.countStaleParserMessages(PARSER_VERSION), 0,
      'the pass finishes rather than re-reading the same rows for ever');
  });

test('the backlog is drained oldest first, and in bounded batches',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, financeMessages } = await setup(t);
    const ids = [];
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      ids.push(await captureAsVersion1(h, 6100 + i, EFS));
    }
    const batch = await financeMessages.listStaleParserMessages({ version: PARSER_VERSION, limit: 2 });
    assert.deepEqual(batch, ids.slice(0, 2), 'a payments table is not rewritten in one sweep');
  });

test('a message captured before the reply column existed still re-reads',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, financeMessages } = await setup(t);
    const id = await captureAsVersion1(h, 6007, EFS);
    await h.query('UPDATE finance_messages SET reply_to_message_id = NULL WHERE id = $1', [id]);

    const out = await financeMessages.reparseMessage(id);
    assert.equal(out.after, 'parsed',
      'nothing captured before this change is lost because it arrived early');
  });

/**
 * THE HALF THAT WAS MISSING. Version 1 had never heard of the word "void"
 * either, so every void in production reads `not_moneycode` today. A re-read
 * that changed the status and stopped there would leave codes the group itself
 * had declared dead sitting in the active total — the same silence this pass
 * exists to end, one step further along.
 */
test('a re-read that newly recognises a void ACTS on it',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, financeMessages } = await setup(t);

    // The code, issued under version 1 and re-read into existence first.
    const issuedId = await captureAsVersion1(h, 6010, EFS);
    const issued = await financeMessages.reparseMessage(issuedId);
    const codeId = await financeMessages.recordMoneycode(issuedId, {
      code: issued.parsed.code,
      codeNormalized: issued.parsed.codeNormalized,
      amount: issued.parsed.amount,
      currency: 'USD',
      issuedAt: new Date('2026-09-10T12:00:00Z'),
      parserVersion: issued.parsed.parserVersion,
    });

    // And the reply that voided it, also captured under version 1.
    const voidId = await captureAsVersion1(h, 6011, 'voided');
    await h.query('UPDATE finance_messages SET reply_to_message_id = 6010, message_date = $2 WHERE id = $1',
      [voidId, new Date('2026-09-10T12:30:00Z')]);

    const out = await financeMessages.reparseMessage(voidId);
    assert.equal(out.before, 'not_moneycode');
    assert.equal(out.after, 'void_action');

    // The context columns the re-read has to hand back for a void to resolve.
    assert.equal(String(out.chatId), CHAT);
    assert.equal(Number(out.replyToMessageId), 6010);
    assert.equal(out.text, 'voided');

    const life = h.loadDataLayer(['financeMoneycodeLifecycle']).financeMoneycodeLifecycle;
    const { applyVoidFromMessage } = require('../services/finance/voidService');
    const applied = await applyVoidFromMessage(
      out.id,
      { chatId: out.chatId, replyToMessageId: out.replyToMessageId, messageDate: out.messageDate },
      out.parsed,
      { lifecycle: life, messages: financeMessages },
    );

    assert.equal(applied.applied, true);
    assert.equal(Number(applied.codeId), Number(codeId));

    const { rows } = await h.query('SELECT status, voided_at FROM finance_moneycodes WHERE id = $1', [codeId]);
    assert.equal(rows[0].status, 'voided');
    assert.ok(rows[0].voided_at, 'and it says when, so the period reports can exclude it');
  });
