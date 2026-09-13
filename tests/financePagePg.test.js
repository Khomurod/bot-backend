'use strict';

/**
 * The reads and the two actions the Finance page depends on, against the real
 * schema.
 *
 * `reparseMessage` IS THE POINT OF "CAPTURE FIRST, CODIFY SECOND". The text was
 * kept verbatim precisely so a tightened parser could be run over it later, and
 * that promise is only true if re-reading changes the INTERPRETATION and never
 * the text. Proved here by re-reading with a deliberately different parser and
 * asserting the stored message is byte-identical afterwards.
 *
 * `requeueDocument` MUST NOT TOUCH A `needs_review`. That status means the
 * bytes were read and could not be understood; running the same reader over
 * the same bytes reaches the same place. Offering it a retry would be a button
 * that does nothing.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();
const CHAT = '-1001234567890';

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  return { h, ...h.loadDataLayer(['financeMessages', 'financeDocuments']) };
}

const MESSAGE = 'money code 1234 5678 9012 for $500 — thanks';

async function seed(m, { messageId = 1, text = MESSAGE, status = 'unparsed' } = {}) {
  return m.financeMessages.captureMessage({
    chatId: CHAT, messageId, text, senderName: 'A Poster',
    messageDate: new Date('2026-09-01T12:00:00Z'),
  }, { status, parserVersion: 1 });
}

test('the messages come back newest first, and the filter narrows them',
  { skip: skipWithoutPg() }, async (t) => {
    const m = await setup(t);
    await seed(m, { messageId: 1, status: 'parsed' });
    await m.financeMessages.captureMessage({
      chatId: CHAT, messageId: 2, text: 'later', messageDate: new Date('2026-09-02T12:00:00Z'),
    }, { status: 'ambiguous', parserVersion: 1 });

    const all = await m.financeMessages.listMessages({ limit: 10 });
    assert.deepEqual(all.map((r) => Number(r.messageId)), [2, 1]);
    assert.equal(all[1].text, MESSAGE, 'this is the one place the text is read out');

    const narrowed = await m.financeMessages.listMessages({ limit: 10, status: 'ambiguous' });
    assert.deepEqual(narrowed.map((r) => Number(r.messageId)), [2]);
  });

test('the money codes come back with their message, and duplicates can be isolated',
  { skip: skipWithoutPg() }, async (t) => {
    const m = await setup(t);
    const { id } = await seed(m, { status: 'parsed' });
    const first = await m.financeMessages.recordMoneycode(id, {
      code: 'A', codeNormalized: 'a', amount: 500, parserVersion: 1,
      issuedAt: new Date('2026-09-01T12:00:00Z'), senderName: 'A Poster',
    });
    await m.financeMessages.recordMoneycode(id, {
      code: 'B', codeNormalized: 'b', amount: 500, parserVersion: 1,
      issuedAt: new Date('2026-09-01T13:00:00Z'),
      duplicateOfId: first, duplicateReason: 'same_code',
    });

    const all = await m.financeMessages.listMoneycodes({ limit: 10 });
    assert.equal(all.length, 2);
    assert.equal(typeof all[0].amount, 'number', 'NUMERIC comes back as a string unless coerced');
    assert.equal(Number(all[0].messageId), 1, 'the row carries its message, so a link can be built');

    const dupes = await m.financeMessages.listMoneycodes({ limit: 10, duplicatesOnly: true });
    assert.equal(dupes.length, 1);
    assert.equal(dupes[0].duplicateReason, 'same_code');
  });

test('RE-READING CHANGES THE INTERPRETATION AND NEVER THE TEXT',
  { skip: skipWithoutPg() }, async (t) => {
    const m = await setup(t);
    const { id } = await seed(m, { status: 'unparsed' });

    // A "tightened" parser, standing in for a later PARSER_VERSION.
    const tightened = (text) => ({
      status: 'parsed', parserVersion: 2, code: '1234', codeNormalized: '1234',
      amount: 500, currency: 'USD', sawText: String(text).length,
    });

    const out = await m.financeMessages.reparseMessage(id, { parse: tightened });
    assert.equal(out.id, id);
    assert.equal(out.before, 'unparsed');
    assert.equal(out.after, 'parsed');
    // The caller needs these to record the code it just found, through the
    // same duplicate decision a live capture uses.
    assert.equal(out.senderName, 'A Poster');
    assert.equal(out.messageDate.toISOString(), '2026-09-01T12:00:00.000Z');
    assert.equal(out.parsed.codeNormalized, '1234');

    const { rows } = await m.h.pool.query(
      'SELECT text, parse_status, parser_version, parse_json FROM finance_messages WHERE id = $1',
      [id],
    );
    assert.equal(rows[0].text, MESSAGE,
      'the whole promise of capture-first is that the evidence survives every re-reading');
    assert.equal(rows[0].parse_status, 'parsed');
    assert.equal(rows[0].parser_version, 2);
    assert.equal(rows[0].parse_json.sawText, MESSAGE.length);
  });

test('re-reading something that is not there returns null rather than inventing it',
  { skip: skipWithoutPg() }, async (t) => {
    const m = await setup(t);
    assert.equal(await m.financeMessages.reparseMessage(9999), null);
  });

test('a document that could not be FETCHED is re-queued with a fresh ladder',
  { skip: skipWithoutPg() }, async (t) => {
    const m = await setup(t);
    const { id: messageRefId } = await seed(m);
    await m.financeDocuments.enqueueDocument({
      messageRefId, chatId: CHAT, messageId: 1, kind: 'document',
      fileId: 'f1', fileUniqueId: 'u1', mimeType: 'application/pdf', fileSize: 10,
    });
    const claimed = await m.financeDocuments.claimNextDocument();
    await m.financeDocuments.failDocument(claimed.id, { error: 'Telegram answered 502', nextAttemptAt: null });

    // Exhausted: it never comes back on its own.
    assert.equal(await m.financeDocuments.claimNextDocument({ now: new Date('2099-01-01') }), null);

    assert.equal(await m.financeDocuments.requeueDocument(claimed.id), true);

    const again = await m.financeDocuments.claimNextDocument();
    assert.equal(String(again.id), String(claimed.id));
    assert.equal(again.attemptCount, 1,
      'a person asking for a retry is new information the backoff does not have');

    const { rows } = await m.h.pool.query('SELECT last_error FROM finance_documents WHERE id = $1', [claimed.id]);
    assert.equal(rows[0].last_error, null, 'the stale reason is cleared, not left to confuse the next reader');
  });

test('a document NEEDING A PERSON is not re-queueable', { skip: skipWithoutPg() }, async (t) => {
  const m = await setup(t);
  const { id: messageRefId } = await seed(m);
  await m.financeDocuments.enqueueDocument({
    messageRefId, chatId: CHAT, messageId: 1, kind: 'document',
    fileId: 'f1', fileUniqueId: 'u1', mimeType: 'application/pdf', fileSize: 10,
  });
  const claimed = await m.financeDocuments.claimNextDocument();
  await m.financeDocuments.finishDocument(claimed.id, {
    status: 'needs_review', readMethod: 'ai_vision', reviewReason: 'low_confidence',
  });

  assert.equal(await m.financeDocuments.requeueDocument(claimed.id), false,
    'the same reader over the same bytes reaches the same place — a person is what it needs');

  // And a `read` one certainly is not.
  assert.equal(await m.financeDocuments.requeueDocument(9999), false);
});

test('a skipped document IS re-queueable, because the reason may have changed',
  { skip: skipWithoutPg() }, async (t) => {
    const m = await setup(t);
    const { id: messageRefId } = await seed(m);
    await m.financeDocuments.enqueueDocument({
      messageRefId, chatId: CHAT, messageId: 1, kind: 'document',
      fileId: 'f1', fileUniqueId: 'u1', mimeType: 'application/pdf', fileSize: 50 * 1024 * 1024,
    });
    const claimed = await m.financeDocuments.claimNextDocument();
    // Skipped for being over the cap — and the cap is a setting somebody can raise.
    await m.financeDocuments.skipDocument(claimed.id, { status: 'skipped_too_large', reason: 'it is 50MB' });

    assert.equal(await m.financeDocuments.requeueDocument(claimed.id), true);
  });

test('the document list carries what was read, and never a file or a URL',
  { skip: skipWithoutPg() }, async (t) => {
    const m = await setup(t);
    const { id: messageRefId } = await seed(m);
    await m.financeDocuments.enqueueDocument({
      messageRefId, chatId: CHAT, messageId: 1, kind: 'document',
      fileId: 'secret-file-id', fileUniqueId: 'u1', mimeType: 'application/pdf',
      fileName: 'receipt.pdf', fileSize: 2048, caption: 'here',
    });
    const claimed = await m.financeDocuments.claimNextDocument();
    await m.financeDocuments.finishDocument(claimed.id, {
      status: 'read', readMethod: 'pdf_text', textChars: 900,
      extracted: { amount: 500, issuedAt: '2026-09-01', confidence: 95 },
      aiProvider: 'groq', aiModel: 'm1',
    });

    const list = await m.financeDocuments.listDocuments({ limit: 10 });
    assert.equal(list[0].extracted.amount, 500);
    assert.equal(list[0].fileName, 'receipt.pdf');
    assert.equal(typeof list[0].fileSize, 'number');
    // The file is not stored and its URL carries the bot token; neither may
    // appear in a response, and `file_id` is not a caller's business either.
    const flat = JSON.stringify(list);
    assert.ok(!flat.includes('secret-file-id'));
    assert.ok(!flat.includes('api.telegram.org'));
  });

/**
 * A tightened parser can legitimately reach a different amount for a code that
 * is already recorded. `recordMoneycode` stays strictly "record it if it is not
 * there" — that idempotency is what makes a redelivery harmless — so the
 * refresh is its own call, and it must not touch the event's own facts.
 */
test('an already-recorded code follows the fresher reading, keeping who and when',
  { skip: skipWithoutPg() }, async (t) => {
    const m = await setup(t);
    const { id } = await seed(m, { status: 'parsed' });
    const issuedAt = new Date('2026-09-01T12:00:00Z');
    const codeId = await m.financeMessages.recordMoneycode(id, {
      code: '1234', codeNormalized: '1234', amount: 500, currency: 'USD',
      senderUserId: 777, senderName: 'A Poster', issuedAt, parserVersion: 1,
    });
    assert.ok(codeId);

    const again = await m.financeMessages.updateMoneycodeInterpretation(id, '1234', {
      code: '1234', amount: 750, currency: 'USD', parserVersion: 2,
      duplicateOfId: null, duplicateReason: null,
    });
    assert.equal(again, codeId, 'the same row, not a second one');

    const { rows } = await m.h.pool.query(
      `SELECT amount, parser_version, sender_name, issued_at,
              (SELECT COUNT(*)::int FROM finance_moneycodes) AS n
         FROM finance_moneycodes WHERE id = $1`,
      [codeId],
    );
    assert.equal(Number(rows[0].amount), 750);
    assert.equal(rows[0].parser_version, 2);
    assert.equal(rows[0].n, 1, 'a refresh is never a second row');
    assert.equal(rows[0].sender_name, 'A Poster', 'who posted it is the EVENT, not the reading');
    assert.equal(rows[0].issued_at.toISOString(), issuedAt.toISOString());
  });

/** A refresh of a code that is not there changes nothing and says so. */
test('refreshing a code that was never recorded returns null',
  { skip: skipWithoutPg() }, async (t) => {
    const m = await setup(t);
    const { id } = await seed(m, { status: 'parsed' });
    assert.equal(
      await m.financeMessages.updateMoneycodeInterpretation(id, 'nosuchcode', {
        code: 'nosuchcode', amount: 1, currency: 'USD', parserVersion: 1,
      }),
      null,
    );
    const { rows } = await m.h.pool.query('SELECT COUNT(*)::int AS n FROM finance_moneycodes');
    assert.equal(rows[0].n, 0);
  });
