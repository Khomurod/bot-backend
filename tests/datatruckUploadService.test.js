/**
 * Tests for services/datatruckUploadService.js — the upload orchestration:
 * merge → hash → duplicate check → DRY-RUN gate → upload → record. All deps are
 * injected so no DB/network/real merge is needed. The real Datatruck upload
 * must NOT run in dry-run mode; a duplicate must be skipped; a failure recorded.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const uploader = require('../services/datatruckUploadService');

function makeDeps({ dryRun, existingDup = null, uploadImpl } = {}) {
  const recorded = [];
  const marks = [];
  const deps = {
    config: { datatruckDocUploadDryRun: dryRun },
    merge: {
      async prepareUpload(files, opts) {
        return { buffer: Buffer.from('MERGED-PDF-BYTES'), filename: `${opts.baseName}.pdf`, mimeType: 'application/pdf', merged: files.length > 1 };
      },
    },
    docs: {
      async findUploadedAttempt() { return existingDup; },
      async recordUploadAttempt(row) { const r = { id: recorded.length + 1, ...row }; recorded.push(r); return r; },
      async markUploadAttempt(id, patch) { marks.push({ id, ...patch }); return { id, ...patch }; },
    },
    datatruck: {
      maskToken: (t) => t,
      uploadOrderDocument: uploadImpl || (async () => ({ documentId: 'DTDOC-1', fileLink: 'https://x/y.pdf' })),
    },
  };
  return { deps, recorded, marks };
}

const FILES = [{ buffer: Buffer.from('a'), mimeType: 'image/jpeg' }, { buffer: Buffer.from('b'), mimeType: 'image/jpeg' }];

test('dry-run: does NOT call the Datatruck upload, records dry_run, clear message', async () => {
  let uploadCalled = false;
  const { deps, recorded } = makeDeps({ dryRun: true, uploadImpl: async () => { uploadCalled = true; return {}; } });
  const res = await uploader.uploadConfirmedBatch({
    batchId: 1, orderId: 13367, loadReference: '9188060', documentType: 'proof_of_delivery', files: FILES,
  }, deps);
  assert.equal(res.status, 'dry_run');
  assert.equal(uploadCalled, false, 'upload must not be called in dry-run');
  assert.match(res.message, /Test mode/i);
  assert.equal(recorded.at(-1).status, 'dry_run');
});

test('duplicate (same hash / order / type) is skipped before any upload', async () => {
  let uploadCalled = false;
  const { deps } = makeDeps({ dryRun: false, existingDup: { id: 42, dry_run: false }, uploadImpl: async () => { uploadCalled = true; return {}; } });
  const res = await uploader.uploadConfirmedBatch({
    orderId: 13367, documentType: 'bill_of_lading', files: FILES,
  }, deps);
  assert.equal(res.status, 'skipped_duplicate');
  assert.equal(res.duplicateOf, 42);
  assert.equal(uploadCalled, false);
  assert.match(res.message, /already uploaded/i);
});

test('live: uploads once, records the Datatruck document id', async () => {
  const { deps, marks } = makeDeps({ dryRun: false });
  const res = await uploader.uploadConfirmedBatch({
    batchId: 5, orderId: 13367, loadReference: '9188060', documentType: 'proof_of_delivery', files: FILES,
  }, deps);
  assert.equal(res.status, 'uploaded');
  assert.equal(res.documentId, 'DTDOC-1');
  assert.equal(marks.at(-1).status, 'uploaded');
  assert.equal(marks.at(-1).datatruckDocumentId, 'DTDOC-1');
});

test('live upload failure is recorded as failed and token is masked', async () => {
  const { deps, marks } = makeDeps({
    dryRun: false,
    uploadImpl: async () => { const e = new Error('Datatruck upload 500: boom'); e.status = 500; throw e; },
  });
  const res = await uploader.uploadConfirmedBatch({ orderId: 13367, documentType: 'bill_of_lading', files: FILES }, deps);
  assert.equal(res.status, 'failed');
  assert.equal(res.httpStatus, 500);
  assert.equal(marks.at(-1).status, 'failed');
});

test('merge failure short-circuits to failed (never uploads a broken file)', async () => {
  const { deps } = makeDeps({ dryRun: false });
  deps.merge.prepareUpload = async () => { throw new Error('Unsupported file type for merge'); };
  let uploadCalled = false;
  deps.datatruck.uploadOrderDocument = async () => { uploadCalled = true; return {}; };
  const res = await uploader.uploadConfirmedBatch({ orderId: 1, documentType: 'bill_of_lading', files: FILES }, deps);
  assert.equal(res.status, 'failed');
  assert.equal(res.stage, 'merge');
  assert.equal(uploadCalled, false);
});

test('sha256Hex is stable for identical bytes', () => {
  assert.equal(uploader.sha256Hex(Buffer.from('x')), uploader.sha256Hex(Buffer.from('x')));
  assert.notEqual(uploader.sha256Hex(Buffer.from('x')), uploader.sha256Hex(Buffer.from('y')));
});
