/**
 * Tests for services/documentIntakeService.js — decision routing and the
 * Yes/No/Disregard confirmation flow, with the DB / classifier / matcher /
 * uploader / downloader all injected (no network/DB).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const svc = require('../services/documentIntakeService');

/** Minimal in-memory docs stub. */
function makeDocs(initialBatch) {
  const batch = { id: 1, status: 'collecting', ...initialBatch };
  const files = [{ telegram_file_id: 'F1', mime_type: 'application/pdf', file_name: 'p.pdf', kind: 'pdf' }];
  const updates = [];
  return {
    _batch: batch,
    async getBatchById() { return { ...batch }; },
    async listBatchFiles() { return files; },
    async updateBatch(id, patch) { Object.assign(batch, patch); updates.push(patch); return { ...batch }; },
    async markBatchDecision(id, { status, decidedByUserId = null, decidedByUsername = null }) {
      if (batch.status !== 'waiting_confirmation') return null;
      batch.status = status;
      batch.decided_by_user_id = decidedByUserId;
      batch.decided_by_username = decidedByUsername;
      return { ...batch };
    },
    async claimBatchForUpload(id, { decidedByUserId = null, decidedByUsername = null } = {}) {
      if (batch.status !== 'waiting_confirmation') return null;
      batch.status = 'uploading';
      batch.decided_by_user_id = decidedByUserId;
      batch.decided_by_username = decidedByUsername;
      return { ...batch };
    },
    _updates: updates,
  };
}

const downloadFile = async () => Buffer.from('PDFDATA');

test('bol + matched load → confirm (waiting_confirmation) with keyboard', async () => {
  const docs = makeDocs();
  const res = await svc.processCollectedBatch(1, {
    docs,
    downloadFile,
    classifier: { classifyBatch: async () => ({ type: 'bol', confidence: 0.9, summary: 'BOL header' }) },
    matcher: { matchLoadForBatch: async () => ({ confidence: 'high', orderId: '13367', loadReference: '9188060', reasons: ['load number matched'] }) },
    config: { datatruckDocUploadDryRun: true },
    getContext: async () => ({ group: { group_name: 'W 771 JOE' }, driverProfile: { full_name: 'Joe', unit_number: '771' } }),
  });
  assert.equal(res.action, 'confirm');
  assert.equal(docs._batch.status, 'waiting_confirmation');
  assert.ok(res.keyboard.inline_keyboard[0].length === 3);
  assert.match(res.message, /Test mode/i); // dry-run banner
});

test('unrelated → ignored, no upload offered', async () => {
  const docs = makeDocs();
  const res = await svc.processCollectedBatch(1, {
    docs, downloadFile,
    classifier: { classifyBatch: async () => ({ type: 'unrelated', confidence: 0.6, summary: 'fuel receipt' }) },
    matcher: { matchLoadForBatch: async () => ({ confidence: 'none', orderId: null, reasons: [] }) },
    config: { datatruckDocUploadDryRun: true },
  });
  assert.equal(res.action, 'ignored');
  assert.equal(docs._batch.status, 'ignored');
  assert.equal(res.keyboard, undefined);
});

test('unclear → needs_review (never auto-offers upload)', async () => {
  const docs = makeDocs();
  const res = await svc.processCollectedBatch(1, {
    docs, downloadFile,
    classifier: { classifyBatch: async () => ({ type: 'unclear', confidence: 0.2, summary: 'blurry' }) },
    matcher: { matchLoadForBatch: async () => ({ confidence: 'medium', orderId: '13367', reasons: [] }) },
    config: { datatruckDocUploadDryRun: true },
  });
  assert.equal(res.action, 'needs_review');
  assert.equal(docs._batch.status, 'needs_review');
});

test('pod but no load found → no_match', async () => {
  const docs = makeDocs();
  const res = await svc.processCollectedBatch(1, {
    docs, downloadFile,
    classifier: { classifyBatch: async () => ({ type: 'pod', confidence: 0.8, summary: 'POD' }) },
    matcher: { matchLoadForBatch: async () => ({ confidence: 'none', orderId: null, reasons: ['no load'] }) },
    config: { datatruckDocUploadDryRun: true },
  });
  assert.equal(res.action, 'no_match');
  assert.equal(docs._batch.status, 'no_match');
});

test('mismatch confidence → needs_review (no one-click upload to a wrong load)', async () => {
  const docs = makeDocs();
  const res = await svc.processCollectedBatch(1, {
    docs, downloadFile,
    classifier: { classifyBatch: async () => ({ type: 'pod', confidence: 0.8, summary: 'POD' }) },
    matcher: { matchLoadForBatch: async () => ({ confidence: 'mismatch', orderId: '13367', loadReference: 'L1', reasons: ['load number does not match'] }) },
    config: { datatruckDocUploadDryRun: true },
  });
  assert.equal(res.action, 'needs_review');
  assert.equal(docs._batch.status, 'needs_review');
  assert.equal(res.keyboard, undefined);
  assert.match(res.message, /DIFFERENT load/i);
});

// A plain, non-admin user — the whole point is that authorization is not needed.
const randomUser = { id: 4242, username: 'random_driver', first_name: 'Random', last_name: 'Driver' };

test('any (non-admin) user can click Yes in dry-run → simulated upload, marked uploaded', async () => {
  const docs = makeDocs({ status: 'waiting_confirmation', detected_doc_type: 'pod', datatruck_order_id: '13367', datatruck_load_reference: '9188060' });
  let called = false;
  const res = await svc.handleConfirmation({ batchId: 1, action: 'yes', user: randomUser }, {
    docs, downloadFile,
    uploader: { uploadConfirmedBatch: async () => { called = true; return { status: 'dry_run', message: 'Test mode: feature is working. Would upload proof_of_delivery to Datatruck load 9188060.' }; } },
  });
  assert.equal(called, true);
  assert.equal(res.status, 'uploaded');
  assert.match(res.reply, /Test mode/i);
  assert.ok(!res.alert, 'no unauthorized alert for a normal user');
});

test('any (non-admin) user can click Yes in live mode → calls the upload flow', async () => {
  const docs = makeDocs({ status: 'waiting_confirmation', detected_doc_type: 'bol', datatruck_order_id: '13367', datatruck_load_reference: '9188060' });
  let uploaded = false;
  const res = await svc.handleConfirmation({ batchId: 1, action: 'yes', user: randomUser }, {
    docs, downloadFile,
    uploader: { uploadConfirmedBatch: async () => { uploaded = true; return { status: 'uploaded' }; } },
  });
  assert.equal(uploaded, true, 'live upload flow was invoked for a normal user');
  assert.equal(res.status, 'uploaded');
  assert.match(res.reply, /succeeded/i);
});

test('any (non-admin) user can click No → needs_review, no upload', async () => {
  const docs = makeDocs({ status: 'waiting_confirmation', detected_doc_type: 'pod', datatruck_order_id: '1' });
  let called = false;
  const res = await svc.handleConfirmation({ batchId: 1, action: 'no', user: randomUser }, {
    docs, downloadFile, uploader: { uploadConfirmedBatch: async () => { called = true; return {}; } },
  });
  assert.equal(res.status, 'needs_review');
  assert.match(res.reply, /Marked for review/i);
  assert.equal(called, false);
});

test('any (non-admin) user can click Disregard → ignored', async () => {
  const docs = makeDocs({ status: 'waiting_confirmation', detected_doc_type: 'pod', datatruck_order_id: '1' });
  const res = await svc.handleConfirmation({ batchId: 1, action: 'disc', user: randomUser }, { docs, downloadFile });
  assert.equal(res.status, 'ignored');
  assert.match(res.reply, /Disregarded/i);
});

test('double-click Yes uploads only once (second claim returns "Already handled")', async () => {
  const docs = makeDocs({ status: 'waiting_confirmation', detected_doc_type: 'bol', datatruck_order_id: '13367', datatruck_load_reference: 'L1' });
  let uploads = 0;
  const deps = {
    docs, downloadFile,
    uploader: { uploadConfirmedBatch: async () => { uploads += 1; return { status: 'uploaded' }; } },
  };
  const first = await svc.handleConfirmation({ batchId: 1, action: 'yes', user: { id: 7 } }, deps);
  const second = await svc.handleConfirmation({ batchId: 1, action: 'yes', user: { id: 7 } }, deps);
  assert.equal(first.status, 'uploaded');
  assert.equal(second.handled, false);
  assert.match(second.reply, /Already handled/i);
  assert.equal(uploads, 1);
});

test('two DIFFERENT users clicking Yes still results in exactly one upload', async () => {
  const docs = makeDocs({ status: 'waiting_confirmation', detected_doc_type: 'bol', datatruck_order_id: '13367', datatruck_load_reference: 'L1' });
  let uploads = 0;
  const deps = {
    docs, downloadFile,
    uploader: { uploadConfirmedBatch: async () => { uploads += 1; return { status: 'uploaded' }; } },
  };
  const first = await svc.handleConfirmation({ batchId: 1, action: 'yes', user: { id: 7, username: 'alice' } }, deps);
  const second = await svc.handleConfirmation({ batchId: 1, action: 'yes', user: { id: 8, username: 'bob' } }, deps);
  assert.equal(first.status, 'uploaded');
  assert.equal(second.handled, false);
  assert.match(second.reply, /Already handled/i);
  assert.equal(uploads, 1);
});

test('No clicked first → a later Yes returns "Already handled" (no upload)', async () => {
  const docs = makeDocs({ status: 'waiting_confirmation', detected_doc_type: 'bol', datatruck_order_id: '13367', datatruck_load_reference: 'L1' });
  let uploads = 0;
  const deps = { docs, downloadFile, uploader: { uploadConfirmedBatch: async () => { uploads += 1; return { status: 'uploaded' }; } } };
  const no = await svc.handleConfirmation({ batchId: 1, action: 'no', user: { id: 7 } }, deps);
  const yes = await svc.handleConfirmation({ batchId: 1, action: 'yes', user: { id: 8 } }, deps);
  assert.equal(no.status, 'needs_review');
  assert.equal(yes.handled, false);
  assert.match(yes.reply, /Already handled/i);
  assert.equal(uploads, 0);
});

test('Disregard clicked first → a later Yes returns "Already handled" (no upload)', async () => {
  const docs = makeDocs({ status: 'waiting_confirmation', detected_doc_type: 'bol', datatruck_order_id: '13367', datatruck_load_reference: 'L1' });
  let uploads = 0;
  const deps = { docs, downloadFile, uploader: { uploadConfirmedBatch: async () => { uploads += 1; return { status: 'uploaded' }; } } };
  const disc = await svc.handleConfirmation({ batchId: 1, action: 'disc', user: { id: 7 } }, deps);
  const yes = await svc.handleConfirmation({ batchId: 1, action: 'yes', user: { id: 8 } }, deps);
  assert.equal(disc.status, 'ignored');
  assert.equal(yes.handled, false);
  assert.match(yes.reply, /Already handled/i);
  assert.equal(uploads, 0);
});

test('Disregard marks ignored; a second press says Already handled', async () => {
  const docs = makeDocs({ status: 'waiting_confirmation', detected_doc_type: 'pod', datatruck_order_id: '1' });
  const first = await svc.handleConfirmation({ batchId: 1, action: 'disc', user: { id: 7 } }, { docs, downloadFile });
  const second = await svc.handleConfirmation({ batchId: 1, action: 'disc', user: { id: 7 } }, { docs, downloadFile });
  assert.equal(first.status, 'ignored');
  assert.equal(second.handled, false);
});

test('records WHO clicked (decided_by_*) for audit, without gating on it', async () => {
  const docs = makeDocs({ status: 'waiting_confirmation', detected_doc_type: 'pod', datatruck_order_id: '13367', datatruck_load_reference: 'L1' });
  await svc.handleConfirmation({ batchId: 1, action: 'yes', user: randomUser }, {
    docs, downloadFile, uploader: { uploadConfirmedBatch: async () => ({ status: 'dry_run', message: 'Test mode' }) },
  });
  assert.equal(docs._batch.decided_by_user_id, '4242');
  assert.equal(docs._batch.decided_by_username, 'random_driver');
});

test('records the clicker display name when there is no @username', async () => {
  const docs = makeDocs({ status: 'waiting_confirmation', detected_doc_type: 'pod', datatruck_order_id: '1' });
  await svc.handleConfirmation({ batchId: 1, action: 'no', user: { id: 55, first_name: 'No', last_name: 'Handle' } }, { docs, downloadFile });
  assert.equal(docs._batch.decided_by_user_id, '55');
  assert.equal(docs._batch.decided_by_username, 'No Handle');
});

test('confirmation on a gone/expired batch is handled clearly', async () => {
  const docs = { async getBatchById() { return null; } };
  const res = await svc.handleConfirmation({ batchId: 999, action: 'yes', user: { id: 7 } }, { docs, downloadFile });
  assert.equal(res.handled, false);
  assert.match(res.reply, /no longer available/i);
});
