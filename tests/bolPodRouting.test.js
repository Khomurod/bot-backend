/**
 * Routing-engine tests for admin-controlled BOL/POD forwarding.
 *
 * The DataTruck client, driver-group directory, Telegram bot, settings store and
 * the delivery DB helper are stubbed via the module cache, so these exercise the
 * pure routing logic in services/datatruckDocumentService.js (which destinations
 * get sent, same-group protection, partial-failure retry, duplicate suppression,
 * type filter, uncertain policy, disabled gate) without a database or network.
 *
 * The stubbed docsDb models the real per-destination claim semantics: a 'sent'
 * destination is never re-claimed (so it is never resent), and a 'failed' one is.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.JWT_SECRET ||= 'test-secret';
process.env.BOT_TOKEN ||= '000:testbot';
process.env.TELEGRAM_BOT_TOKEN ||= '000:testnotif';
process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.DATABASE_URL ||= 'postgresql://localhost:5432/unused_in_this_test';

const ROOT = path.resolve(__dirname, '..');
const P = (rel) => path.resolve(ROOT, rel);
// Key the cache by the fully-resolved filename (with extension) so the stub
// actually shadows the real module when the service requires it.
function stub(rel, exports) {
  const filename = require.resolve(P(rel));
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
  return exports;
}

// ── In-memory delivery store modelling the per-destination claim state machine ──
let idSeq = 1;
const store = new Map(); // signature -> row
function resetStore() { store.clear(); idSeq = 1; }
function rowById(id) { for (const r of store.values()) if (r.id === id) return r; return null; }
const COLS = {
  driver: { status: 'status', attempt: 'attempt_count', err: 'last_error' },
  central: { status: 'central_status', attempt: 'central_attempt_count', err: 'central_last_error' },
};
const docsDbStub = {
  async upsertDelivery(meta) {
    if (store.has(meta.signature)) return { row: store.get(meta.signature), isNew: false };
    const row = {
      id: idSeq++, ...meta,
      status: 'pending', central_status: 'pending',
      attempt_count: 0, central_attempt_count: 0,
      last_error: null, central_last_error: null,
      telegram_group_id: null, central_telegram_group_id: null,
      telegram_message_id: null, central_telegram_message_id: null,
      group_id: null, matched_by: null,
    };
    store.set(meta.signature, row);
    return { row, isNew: true };
  },
  async claimDestination(id, dest, { maxAttempts = 6 } = {}) {
    const row = rowById(id); const c = COLS[dest];
    const eligible = ['pending', 'failed', 'skipped_no_group'].includes(row[c.status]) && row[c.attempt] < maxAttempts;
    if (!eligible) return null;
    row[c.status] = 'processing'; row[c.attempt] += 1;
    return row;
  },
  async markDestinationSent(id, dest, { telegramGroupId = null, messageId = null, groupId = null, matchedBy = null } = {}) {
    const row = rowById(id); const c = COLS[dest];
    row[c.status] = 'sent'; row[c.err] = null;
    if (dest === 'driver') { row.telegram_group_id = telegramGroupId; row.telegram_message_id = messageId; row.group_id = groupId; row.matched_by = matchedBy; }
    else { row.central_telegram_group_id = telegramGroupId; row.central_telegram_message_id = messageId; }
    return row;
  },
  async markDestinationFailed(id, dest, error) {
    const row = rowById(id); const c = COLS[dest];
    row[c.status] = 'failed'; row[c.err] = String(error || '').slice(0, 500); return row;
  },
  async markDestinationSkipped(id, dest, skipStatus) {
    const row = rowById(id); row[COLS[dest].status] = skipStatus; return row;
  },
  async recordBackfillSuppressed(meta) {
    if (store.has(meta.signature)) return false;
    store.set(meta.signature, { id: idSeq++, ...meta, status: 'suppressed_backfill', central_status: 'skipped_not_applicable' });
    return true;
  },
};

// ── Telegram send stub ──
let sends = [];
const failChatIds = new Set();
let sendSeq = 100;
const telegramStub = {
  async sendDocument(chatId, _input, _extra) {
    const id = String(chatId);
    sends.push(id);
    if (failChatIds.has(id)) {
      const err = new Error('Forbidden'); err.response = { error_code: 403, description: 'Forbidden: bot is not a member' };
      throw err;
    }
    return { message_id: sendSeq++ };
  },
};

// ── matchDocumentToGroup stub (controllable per test) ──
let matchResult = null;
const realHelpers = require(P('services/datatruckDocumentHelpers'));
stub('services/datatruckDocumentHelpers', { ...realHelpers, matchDocumentToGroup: () => matchResult });

// ── Settings + DataTruck + directory stubs (for runOnce/tick gate tests) ──
let settingsConfig = { enabled: true, deliveryMode: 'driver_group', centralGroupId: null, documentTypeMode: 'both', uncertainDocumentPolicy: 'do_not_send' };
stub('database/bolPodForwardingSettings', { getBolPodConfig: async () => settingsConfig });
let ordersToReturn = [];
stub('services/datatruckApiService', { isConfigured: () => true, fetchOrdersByDocumentWindow: async () => ordersToReturn });
stub('services/driverGroupDirectoryService', { listCanonicalDriverGroups: async () => [] });
stub('bot/bot', { bot: { telegram: telegramStub } });
stub('database/datatruckDocuments', docsDbStub);

// Now load the service under test (picks up all stubs above).
const svc = require(P('services/datatruckDocumentService'));

function makeDoc(overrides = {}) {
  return {
    signature: overrides.signature || `sig-${Math.random().toString(36).slice(2)}`,
    orderId: 'ORD1', loadReference: 'DT-1001', fileType: 'bill_of_lading',
    fileLink: 'https://example.com/doc.pdf', uploadedBy: 'John Smith',
    uploadedAt: '2026-07-14T10:00:00Z', uploadedAtMs: Date.parse('2026-07-14T10:00:00Z'),
    driverNames: ['John Smith'], unitNumber: '102', ...overrides,
  };
}
const DRIVER_GROUP = { telegram_group_id: -100111, group_id: 11, group_name: 'Driver A' };
function baseCtx(overrides = {}) {
  return {
    dest: svc.destinationsForMode('driver_group'),
    documentTypeMode: 'both', uncertainPolicy: 'do_not_send',
    centralGroupId: null, centralApplicable: false,
    index: { byNameKey: new Map() }, cutoffMs: 0, ...overrides,
  };
}
function beforeEach() { resetStore(); sends = []; failChatIds.clear(); matchResult = null; }

test('driver-only: sends only to the driver group (BOL)', async () => {
  beforeEach(); matchResult = { group: DRIVER_GROUP, matchedBy: 'name' };
  const doc = makeDoc();
  const r = await svc.routeDocument(doc, baseCtx({ dest: svc.destinationsForMode('driver_group') }));
  assert.equal(r.driverSent, true);
  assert.deepEqual(sends, ['-100111']);
  const row = store.get(doc.signature);
  assert.equal(row.status, 'sent');
  assert.equal(row.central_status, 'skipped_not_applicable');
});

test('POD is processed the same as BOL', async () => {
  beforeEach(); matchResult = { group: DRIVER_GROUP, matchedBy: 'name' };
  const doc = makeDoc({ fileType: 'proof_of_delivery' });
  const r = await svc.routeDocument(doc, baseCtx());
  assert.equal(r.driverSent, true);
  assert.equal(store.get(doc.signature).doc_classification || 'pod', 'pod');
});

test('central-only: sends only to the central group', async () => {
  beforeEach();
  const doc = makeDoc();
  const r = await svc.routeDocument(doc, baseCtx({
    dest: svc.destinationsForMode('central_group'), centralGroupId: '-100999', centralApplicable: true,
  }));
  assert.equal(r.centralSent, true);
  assert.deepEqual(sends, ['-100999']);
  const row = store.get(doc.signature);
  assert.equal(row.central_status, 'sent');
  assert.equal(row.status, 'skipped_not_applicable');
});

test('central-only still works when the driver mapping is missing', async () => {
  beforeEach(); matchResult = null; // no driver group
  const doc = makeDoc();
  const r = await svc.routeDocument(doc, baseCtx({
    dest: svc.destinationsForMode('central_group'), centralGroupId: '-100999', centralApplicable: true,
  }));
  assert.equal(r.centralSent, true);
  assert.deepEqual(sends, ['-100999']);
});

test('both: sends once to each destination', async () => {
  beforeEach(); matchResult = { group: DRIVER_GROUP, matchedBy: 'name' };
  const doc = makeDoc();
  const r = await svc.routeDocument(doc, baseCtx({
    dest: svc.destinationsForMode('both'), centralGroupId: '-100999', centralApplicable: true,
  }));
  assert.equal(r.driverSent, true);
  assert.equal(r.centralSent, true);
  assert.deepEqual(sends.sort(), ['-100111', '-100999']);
  const row = store.get(doc.signature);
  assert.equal(row.status, 'sent');
  assert.equal(row.central_status, 'sent');
});

test('same driver + central group: document sent only once', async () => {
  beforeEach(); matchResult = { group: { telegram_group_id: -100777, group_id: 7, group_name: 'D' }, matchedBy: 'name' };
  const doc = makeDoc();
  const r = await svc.routeDocument(doc, baseCtx({
    dest: svc.destinationsForMode('both'), centralGroupId: '-100777', centralApplicable: true,
  }));
  assert.equal(r.driverSent, true);
  assert.deepEqual(sends, ['-100777']); // exactly one send
  assert.equal(store.get(doc.signature).central_status, 'skipped_same_group');
});

test('missing driver group: nothing sent to any group; marked needs-review', async () => {
  beforeEach(); matchResult = null;
  const doc = makeDoc();
  const r = await svc.routeDocument(doc, baseCtx({ dest: svc.destinationsForMode('driver_group') }));
  assert.equal(r.driverNoGroup, true);
  assert.deepEqual(sends, []);
  assert.equal(store.get(doc.signature).status, 'skipped_no_group');
});

test('both, missing driver group: central still delivers, driver marked needs-review', async () => {
  beforeEach(); matchResult = null;
  const doc = makeDoc();
  const r = await svc.routeDocument(doc, baseCtx({
    dest: svc.destinationsForMode('both'), centralGroupId: '-100999', centralApplicable: true,
  }));
  assert.equal(r.driverNoGroup, true);
  assert.equal(r.centralSent, true);
  assert.deepEqual(sends, ['-100999']);
  const row = store.get(doc.signature);
  assert.equal(row.status, 'skipped_no_group');
  assert.equal(row.central_status, 'sent');
});

test('partial failure: only the failed destination retries; the sent one is not resent', async () => {
  beforeEach(); matchResult = { group: DRIVER_GROUP, matchedBy: 'name' };
  failChatIds.add('-100999'); // central fails first
  const doc = makeDoc();
  const ctx = baseCtx({ dest: svc.destinationsForMode('both'), centralGroupId: '-100999', centralApplicable: true });
  const r1 = await svc.routeDocument(doc, ctx);
  assert.equal(r1.driverSent, true);
  assert.equal(r1.failed, true);
  assert.deepEqual(sends.sort(), ['-100111', '-100999']);
  assert.equal(store.get(doc.signature).status, 'sent');
  assert.equal(store.get(doc.signature).central_status, 'failed');

  // Retry tick: central now succeeds; driver must NOT be resent.
  failChatIds.clear();
  sends = [];
  const r2 = await svc.routeDocument(doc, ctx);
  assert.equal(r2.centralSent, true);
  assert.deepEqual(sends, ['-100999']); // only central
  assert.equal(store.get(doc.signature).status, 'sent');
  assert.equal(store.get(doc.signature).central_status, 'sent');
});

test('duplicate: the same source document is not resent on a later scan', async () => {
  beforeEach(); matchResult = { group: DRIVER_GROUP, matchedBy: 'name' };
  const doc = makeDoc({ signature: 'dup-1' });
  await svc.routeDocument(doc, baseCtx());
  await svc.routeDocument(doc, baseCtx()); // scanned again
  await svc.routeDocument(doc, baseCtx());
  assert.deepEqual(sends, ['-100111']); // sent exactly once across three scans
});

test('document-type filter: POD is skipped when mode is BOL-only (no send, no row)', async () => {
  beforeEach(); matchResult = { group: DRIVER_GROUP, matchedBy: 'name' };
  const doc = makeDoc({ fileType: 'proof_of_delivery', signature: 'pod-x' });
  const r = await svc.routeDocument(doc, baseCtx({ documentTypeMode: 'bol' }));
  assert.equal(r.skippedType, true);
  assert.deepEqual(sends, []);
  assert.equal(store.has('pod-x'), false);
});

test('backfill: undatable/old documents are suppressed, never sent', async () => {
  beforeEach(); matchResult = { group: DRIVER_GROUP, matchedBy: 'name' };
  const doc = makeDoc({ signature: 'old-1', uploadedAtMs: 1000 });
  const r = await svc.routeDocument(doc, baseCtx({ cutoffMs: 2000 }));
  assert.equal(r.backfill, true);
  assert.deepEqual(sends, []);
  assert.equal(store.get('old-1').status, 'suppressed_backfill');
});

test('unclear + do_not_send: nothing is sent to any group', async () => {
  beforeEach(); matchResult = { group: DRIVER_GROUP, matchedBy: 'name' };
  // Untracked file type → classifier returns "unclear" (AI fallback off).
  const doc = makeDoc({ fileType: 'rate_confirmation', signature: 'unc-1' });
  const r = await svc.routeDocument(doc, baseCtx({
    dest: svc.destinationsForMode('both'), centralGroupId: '-100999', centralApplicable: true,
    uncertainPolicy: 'do_not_send',
  }));
  assert.equal(r.skippedUnclear, true);
  assert.deepEqual(sends, []);
  const row = store.get('unc-1');
  assert.equal(row.status, 'skipped_unclear');
  assert.equal(row.central_status, 'skipped_unclear');
});

test('unclear + central_review: sent only to central, never to a driver group', async () => {
  beforeEach(); matchResult = { group: DRIVER_GROUP, matchedBy: 'name' };
  const doc = makeDoc({ fileType: 'rate_confirmation', signature: 'unc-2' });
  const r = await svc.routeDocument(doc, baseCtx({
    dest: svc.destinationsForMode('both'), centralGroupId: '-100999', centralApplicable: true,
    uncertainPolicy: 'central_review',
  }));
  assert.equal(r.centralSent, true);
  assert.deepEqual(sends, ['-100999']); // never the driver group
  assert.equal(store.get('unc-2').status, 'skipped_unclear');
});

test('disabled: runOnce sends nothing', async () => {
  beforeEach();
  settingsConfig = { enabled: false, deliveryMode: 'driver_group', centralGroupId: null, documentTypeMode: 'both', uncertainDocumentPolicy: 'do_not_send' };
  ordersToReturn = [{ documents: [{ file_type: 'bill_of_lading', file_link: 'x' }] }];
  const summary = await svc.runOnce();
  assert.equal(summary.enabled, false);
  assert.deepEqual(sends, []);
  settingsConfig = { enabled: true, deliveryMode: 'driver_group', centralGroupId: null, documentTypeMode: 'both', uncertainDocumentPolicy: 'do_not_send' };
});
