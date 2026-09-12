'use strict';

/**
 * The document queue against the real schema.
 *
 * THE CLAIM IS THE ONE THING NO STUB CAN PROVE. `FOR UPDATE SKIP LOCKED` with
 * `LIMIT 1` is what makes the reader safe to run twice and, more importantly,
 * what makes it sequential — and both of those are properties of PostgreSQL's
 * locking, not of the JavaScript around it. Two claimers racing for one row is
 * exactly the case a stub would get wrong in the reassuring direction.
 *
 * ATTEMPTS COUNT AT CLAIM TIME. A worker that crashes mid-read never reaches
 * its failure handler, so counting on the way out lets a poisoned row be
 * retried forever. That is a property of the UPDATE, so it is tested here.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();
const CHAT = '-1001234567890';

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const loaded = h.loadDataLayer(['financeMessages', 'financeDocuments']);
  const { id } = await loaded.financeMessages.captureMessage({
    chatId: CHAT, messageId: 1, text: 'receipt', hasDocument: true,
    messageDate: new Date('2026-09-01T12:00:00Z'),
  }, { status: 'not_moneycode', parserVersion: 1 });
  return { h, ...loaded, messageRefId: id };
}

function docFields(messageRefId, over = {}) {
  return {
    messageRefId, chatId: CHAT, messageId: 1, kind: 'document',
    fileId: 'f1', fileUniqueId: 'u1', mimeType: 'application/pdf',
    fileName: 'receipt.pdf', fileSize: 1024, caption: 'here', ...over,
  };
}

test('the same file is queued once, however many times it is delivered', { skip: skipWithoutPg() }, async (t) => {
  const { h, financeDocuments, messageRefId } = await setup(t);

  const first = await financeDocuments.enqueueDocument(docFields(messageRefId));
  assert.equal(first.created, true);

  // A Telegram redelivery, and an edit that re-reads the same message.
  const second = await financeDocuments.enqueueDocument(docFields(messageRefId));
  assert.equal(second.created, false);
  // A NEW file_id for the same file — Telegram reissues these. The unique key
  // is on file_unique_id precisely because file_id is not stable.
  const reissued = await financeDocuments.enqueueDocument(docFields(messageRefId, { fileId: 'f1-new' }));
  assert.equal(reissued.created, false);

  const { rows } = await h.pool.query('SELECT COUNT(*)::int AS n FROM finance_documents');
  assert.equal(rows[0].n, 1);
});

test('two claimers cannot take the same row, and one cannot take two',
  { skip: skipWithoutPg() }, async (t) => {
    const { financeDocuments, messageRefId } = await setup(t);
    await financeDocuments.enqueueDocument(docFields(messageRefId, { fileUniqueId: 'u1', messageId: 1 }));
    await financeDocuments.enqueueDocument(docFields(messageRefId, { fileUniqueId: 'u2', messageId: 2 }));

    // Genuinely concurrent: two claims in flight at once against one database.
    const [a, b] = await Promise.all([
      financeDocuments.claimNextDocument(),
      financeDocuments.claimNextDocument(),
    ]);

    assert.ok(a && b, 'both claimers should have found work');
    assert.notEqual(a.id, b.id, 'SKIP LOCKED is what stops two workers reading one document');

    // And nothing is left claimable.
    assert.equal(await financeDocuments.claimNextDocument(), null);
  });

test('an attempt is counted when the row is TAKEN, not when it fails',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, financeDocuments, messageRefId } = await setup(t);
    await financeDocuments.enqueueDocument(docFields(messageRefId));

    const claimed = await financeDocuments.claimNextDocument();
    assert.equal(claimed.attemptCount, 1);

    // The crash case: the worker dies here and never calls failDocument.
    const { rows } = await h.pool.query(
      'SELECT attempt_count, status, processing_started_at FROM finance_documents WHERE id = $1',
      [claimed.id],
    );
    assert.equal(rows[0].attempt_count, 1, 'the attempt is already spent — that is what bounds a crash loop');
    assert.equal(rows[0].status, 'processing');
    assert.notEqual(rows[0].processing_started_at, null);
  });

test('a claim abandoned by a crash is released, and the attempt stays spent',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, financeDocuments, messageRefId } = await setup(t);
    await financeDocuments.enqueueDocument(docFields(messageRefId));
    const claimed = await financeDocuments.claimNextDocument();

    // Nothing releases it on its own: `processing` is in neither the claim
    // query nor the due index, so without the sweep it is stranded forever.
    assert.equal(await financeDocuments.claimNextDocument(), null);

    await h.pool.query(
      "UPDATE finance_documents SET processing_started_at = NOW() - INTERVAL '30 minutes' WHERE id = $1",
      [claimed.id],
    );
    assert.equal(await financeDocuments.releaseStuckDocuments({ olderThanMinutes: 15 }), 1);

    const again = await financeDocuments.claimNextDocument();
    assert.equal(String(again.id), String(claimed.id));
    assert.equal(again.attemptCount, 2, 'a row that keeps killing the worker still runs out of attempts');
  });

test('a fresh claim is not swept away underneath a working reader',
  { skip: skipWithoutPg() }, async (t) => {
    const { financeDocuments, messageRefId } = await setup(t);
    await financeDocuments.enqueueDocument(docFields(messageRefId));
    await financeDocuments.claimNextDocument();
    assert.equal(await financeDocuments.releaseStuckDocuments({ olderThanMinutes: 15 }), 0);
  });

test('a failed download comes back when it is due, and not before',
  { skip: skipWithoutPg() }, async (t) => {
    const { financeDocuments, messageRefId } = await setup(t);
    await financeDocuments.enqueueDocument(docFields(messageRefId));
    const claimed = await financeDocuments.claimNextDocument();

    const soon = new Date(Date.now() + 60 * 60 * 1000);
    await financeDocuments.failDocument(claimed.id, { error: 'Telegram answered 502', nextAttemptAt: soon });

    assert.equal(await financeDocuments.claimNextDocument(), null, 'not due yet');
    const due = await financeDocuments.nextDueAt();
    assert.equal(Math.abs(new Date(due) - soon) < 2000, true);

    const later = await financeDocuments.claimNextDocument({ now: new Date(Date.now() + 2 * 60 * 60 * 1000) });
    assert.ok(later, 'and it does come back once it is due');
  });

test('an exhausted document stops asking, and stops arming a timer',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, financeDocuments, messageRefId } = await setup(t);
    await financeDocuments.enqueueDocument(docFields(messageRefId));
    const claimed = await financeDocuments.claimNextDocument();

    // The ladder is spent: decideRetry returns null and the row parks forever.
    await financeDocuments.failDocument(claimed.id, { error: 'gave up', nextAttemptAt: null });

    const far = new Date('2099-01-01T00:00:00Z');
    assert.equal(await financeDocuments.claimNextDocument({ now: far }), null);
    assert.equal(await financeDocuments.nextDueAt(), null,
      'an exhausted row must not keep arming a retry wake for a moment that never comes');

    const { rows } = await h.pool.query('SELECT status, last_error FROM finance_documents WHERE id = $1', [claimed.id]);
    assert.equal(rows[0].status, 'failed');
    assert.equal(rows[0].last_error, 'gave up');
  });

test('read, needs_review and skipped are all terminal, and each keeps its reason',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, financeDocuments, messageRefId } = await setup(t);
    for (const [i, unique] of ['a', 'b', 'c'].entries()) {
      // eslint-disable-next-line no-await-in-loop
      await financeDocuments.enqueueDocument(
        docFields(messageRefId, { fileUniqueId: unique, messageId: i + 1 }),
      );
    }

    const one = await financeDocuments.claimNextDocument();
    await financeDocuments.finishDocument(one.id, {
      status: 'read', readMethod: 'pdf_text', textChars: 900,
      extracted: { amount: 500, confidence: 92 }, aiProvider: 'groq', aiModel: 'm1',
    });

    const two = await financeDocuments.claimNextDocument();
    await financeDocuments.finishDocument(two.id, {
      status: 'needs_review', readMethod: 'ai_vision', reviewReason: 'ai_unavailable',
    });

    const three = await financeDocuments.claimNextDocument();
    await financeDocuments.skipDocument(three.id, { status: 'skipped_too_large', reason: 'it is 40MB' });

    assert.equal(await financeDocuments.claimNextDocument({ now: new Date('2099-01-01') }), null,
      'none of the three may come back round');

    const { rows } = await h.pool.query(
      'SELECT status, read_method, extracted, review_reason FROM finance_documents ORDER BY id',
    );
    assert.equal(rows[0].extracted.amount, 500);
    assert.equal(rows[1].review_reason, 'ai_unavailable');
    assert.equal(rows[2].review_reason, 'it is 40MB');
  });

test('the schema refuses a status or a read method nobody handles', { skip: skipWithoutPg() }, async (t) => {
  const { h, financeDocuments, messageRefId } = await setup(t);
  await financeDocuments.enqueueDocument(docFields(messageRefId));

  await assert.rejects(
    () => h.pool.query("UPDATE finance_documents SET status = 'probably_fine'"),
    /finance_documents_status/,
  );
  await assert.rejects(
    () => h.pool.query("UPDATE finance_documents SET read_method = 'vibes'"),
    /finance_documents_read_method/,
  );
  await assert.rejects(
    () => h.pool.query("UPDATE finance_documents SET kind = 'video'"),
    /finance_documents_kind/,
  );
});

test('deleting the message takes its documents with it', { skip: skipWithoutPg() }, async (t) => {
  const { h, financeDocuments, messageRefId } = await setup(t);
  await financeDocuments.enqueueDocument(docFields(messageRefId));

  await h.pool.query('DELETE FROM finance_messages WHERE id = $1', [messageRefId]);
  const { rows } = await h.pool.query('SELECT COUNT(*)::int AS n FROM finance_documents');
  assert.equal(rows[0].n, 0, 'a document with no message is a row nothing can explain');
});

test('the summary separates what is waiting from what needs a person', { skip: skipWithoutPg() }, async (t) => {
  const { financeDocuments, messageRefId } = await setup(t);
  for (const [i, unique] of ['a', 'b', 'c', 'd'].entries()) {
    // eslint-disable-next-line no-await-in-loop
    await financeDocuments.enqueueDocument(docFields(messageRefId, { fileUniqueId: unique, messageId: i + 1 }));
  }
  const one = await financeDocuments.claimNextDocument();
  await financeDocuments.finishDocument(one.id, { status: 'read', readMethod: 'pdf_text' });
  const two = await financeDocuments.claimNextDocument();
  await financeDocuments.finishDocument(two.id, { status: 'needs_review', reviewReason: 'low_confidence' });
  const three = await financeDocuments.claimNextDocument();
  await financeDocuments.failDocument(three.id, { error: 'nope', nextAttemptAt: null });

  const summary = await financeDocuments.summariseDocuments();
  assert.equal(summary.available, true);
  assert.equal(summary.total, 4);
  assert.equal(summary.needsReview, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.byStatus.read, 1);
  assert.equal(summary.byStatus.pending, 1);
});
