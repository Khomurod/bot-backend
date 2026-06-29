const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

/**
 * Loads datatruckDocumentService with every external dependency mocked via
 * require.cache so the test needs no installed packages and performs no I/O.
 * The pure helpers module is intentionally left real.
 */
function loadService({
  config: cfg = {},
  datatruck = {},
  docsDb = {},
  directory = [],
  telegram = {},
  permanentSendError = false,
} = {}) {
  const servicePath = path.resolve(__dirname, '../services/datatruckDocumentService.js');
  const configPath = path.resolve(__dirname, '../config/config.js');
  const telegrafPath = require.resolve('telegraf');
  const botPath = path.resolve(__dirname, '../bot/bot.js');
  const htmlPath = path.resolve(__dirname, '../services/telegramHtml.js');
  const datatruckPath = path.resolve(__dirname, '../services/datatruckApiService.js');
  const docsDbPath = path.resolve(__dirname, '../database/datatruckDocuments.js');
  const directoryPath = path.resolve(__dirname, '../services/driverGroupDirectoryService.js');

  for (const p of [servicePath]) delete require.cache[p];

  const calls = {
    sent: [],
    backfill: [],
    claimed: [],
    markedSent: [],
    markedFailed: [],
    markedSkipped: [],
  };

  const configMock = {
    datatruckDocDeliveryEnabled: true,
    datatruckDocPollMinutes: 15,
    datatruckDocLookbackDays: 60,
    datatruckDocSinceIso: '',
    datatruckDocMaxFileMb: 45,
    datatruckDocMediaBaseUrl: 'https://tms-datatruck.s3-accelerate.amazonaws.com/static/',
    datatruckApiToken: 'token',
    datatruckCompany: 'wenze',
    ...cfg,
  };

  const datatruckMock = {
    isConfigured() { return true; },
    async fetchOrdersByDeliveryWindow() { return []; },
    ...datatruck,
  };
  if (typeof datatruckMock.fetchOrdersByDocumentWindow !== 'function') {
    datatruckMock.fetchOrdersByDocumentWindow = (...args) => datatruckMock.fetchOrdersByDeliveryWindow(...args);
  }

  const docsDbMock = {
    async ensureActivationTime() { return new Date('2026-06-01T00:00:00Z'); },
    async recordBackfillSuppressed(meta) { calls.backfill.push(meta); return true; },
    async claimDocumentDelivery(meta) { calls.claimed.push(meta); return { id: calls.claimed.length, ...meta }; },
    async markSent(id, info) { calls.markedSent.push({ id, info }); return { id }; },
    async markFailed(id, error) { calls.markedFailed.push({ id, error }); return { id }; },
    async markSkippedNoGroup(id, info) { calls.markedSkipped.push({ id, info }); return { id }; },
    ...docsDb,
  };

  const telegramMock = {
    async sendDocument(chatId, file, extra) {
      calls.sent.push({ chatId, file, extra });
      return { message_id: 55 };
    },
    ...telegram,
  };

  require.cache[configPath] = { exports: configMock };
  require.cache[telegrafPath] = {
    exports: {
      Input: {
        fromURL: (url, filename) => ({ kind: 'url', url, filename }),
        fromBuffer: (buffer, filename) => ({ kind: 'buffer', buffer, filename }),
      },
    },
  };
  require.cache[botPath] = { exports: { bot: { telegram: telegramMock } } };
  require.cache[htmlPath] = {
    exports: {
      safeSend: async (fn) => fn(),
      isPermanentSendError: () => permanentSendError,
    },
  };
  require.cache[datatruckPath] = { exports: datatruckMock };
  require.cache[docsDbPath] = { exports: docsDbMock };
  require.cache[directoryPath] = {
    exports: { listCanonicalDriverGroups: async () => directory },
  };

  const service = require(servicePath);
  return { service, calls, configMock };
}

const driverGroup = {
  group_type: 'driver',
  group_id: 10,
  group_name: 'WENZE UNIT # 2614 TERRELL DALTON',
  telegram_group_id: '-1002614',
  group_active: true,
  inactive: false,
  operational_visible: true,
  unit_number: '2614',
  normalized_driver_key: 'terrell dalton',
};

const uploaderGroup = {
  ...driverGroup,
  group_id: 20,
  group_name: 'WENZE UNIT # 008 JANE DRIVER',
  telegram_group_id: '-1000008',
  unit_number: '008',
  normalized_driver_key: 'jane driver',
};

function orderWith(documents, trip = {}) {
  return {
    id: 500,
    load_id: 'L-500',
    trip: { truck__unit_number: '2614', driver__full_name: 'Terrell Dalton', ...trip },
    documents,
  };
}

test('forwards a new BOL by driver name despite a non-matching truck number', async () => {
  const { service, calls } = loadService({
    directory: [driverGroup],
    datatruck: {
      async fetchOrdersByDeliveryWindow() {
        return [orderWith([
          { file_type: 'bill_of_lading', file_link: '2026/6/15/uuid/bol_scan.pdf', uploaded_at: '2026-06-15T10:00:00Z', uploaded_by: 'Jane' },
        ], { truck__unit_number: '9999' })];
      },
    },
  });

  const summary = await service.runOnce({ referenceMs: Date.parse('2026-06-20T00:00:00Z') });

  assert.equal(summary.sent, 1);
  assert.equal(summary.backfillSuppressed, 0);
  assert.equal(calls.sent.length, 1);
  assert.equal(calls.sent[0].chatId, '-1002614');
  assert.equal(calls.sent[0].file.kind, 'url');
  // Relative file_link is resolved against the configured media base.
  assert.equal(
    calls.sent[0].file.url,
    'https://tms-datatruck.s3-accelerate.amazonaws.com/static/2026/6/15/uuid/bol_scan.pdf'
  );
  assert.equal(calls.sent[0].extra.parse_mode, 'HTML');
  assert.match(calls.sent[0].extra.caption, /Bill of Lading/);
  assert.equal(calls.markedSent.length, 1);
  assert.equal(calls.markedSent[0].info.telegramGroupId, '-1002614');
  assert.equal(calls.markedSent[0].info.matchedBy, 'name');
});

test('routes BOL to the uploader driver group before the assigned driver group', async () => {
  const { service, calls } = loadService({
    directory: [driverGroup, uploaderGroup],
    datatruck: {
      async fetchOrdersByDeliveryWindow() {
        return [orderWith([
          {
            file_type: 'bill_of_lading',
            file_link: 'https://x/bol.pdf',
            uploaded_at: '2026-06-15T10:00:00Z',
            uploaded_by: { full_name: 'Jane Driver' },
          },
        ])];
      },
    },
  });

  const summary = await service.runOnce({ referenceMs: Date.parse('2026-06-20T00:00:00Z') });

  assert.equal(summary.sent, 1);
  assert.equal(calls.sent[0].chatId, '-1000008');
  assert.equal(calls.markedSent[0].info.groupId, 20);
  assert.equal(calls.markedSent[0].info.matchedBy, 'name');
});

test('forwards a new POD by uploader driver name and marks it sent', async () => {
  const { service, calls } = loadService({
    directory: [driverGroup, uploaderGroup],
    datatruck: {
      async fetchOrdersByDeliveryWindow() {
        return [orderWith([
          {
            file_type: 'proof_of_delivery',
            file_link: '2026/6/15/uuid/pod_scan.pdf',
            uploaded_at: '2026-06-15T11:00:00Z',
            uploaded_by: 'Jane Driver',
          },
        ], { truck__unit_number: '9999' })];
      },
    },
  });

  const summary = await service.runOnce({ referenceMs: Date.parse('2026-06-20T00:00:00Z') });

  assert.equal(summary.sent, 1);
  assert.equal(calls.sent[0].chatId, '-1000008');
  assert.match(calls.sent[0].extra.caption, /Proof of Delivery/);
  assert.equal(calls.sent[0].file.filename, 'POD_L-500.pdf');
  assert.equal(calls.markedSent[0].info.matchedBy, 'name');
});

test('sends BOL and POD from the same order as separate idempotent deliveries', async () => {
  const { service, calls } = loadService({
    directory: [driverGroup],
    datatruck: {
      async fetchOrdersByDeliveryWindow() {
        return [orderWith([
          {
            file_type: 'bill_of_lading',
            file_link: 'https://x/bol.pdf',
            uploaded_at: '2026-06-15T10:00:00Z',
          },
          {
            file_type: 'proof_of_delivery',
            file_link: 'https://x/pod.pdf',
            uploaded_at: '2026-06-15T11:00:00Z',
          },
        ])];
      },
    },
  });

  const summary = await service.runOnce({ referenceMs: Date.parse('2026-06-20T00:00:00Z') });

  assert.equal(summary.documentsScanned, 2);
  assert.equal(summary.sent, 2);
  assert.equal(calls.claimed.length, 2);
  assert.equal(calls.sent.length, 2);
  assert.notEqual(calls.claimed[0].signature, calls.claimed[1].signature);
  assert.deepEqual(calls.sent.map((call) => call.file.filename), ['BOL_L-500.pdf', 'POD_L-500.pdf']);
});

test('suppresses documents uploaded before the activation cutoff (no backfill spam)', async () => {
  const { service, calls } = loadService({
    directory: [driverGroup],
    datatruck: {
      async fetchOrdersByDeliveryWindow() {
        return [orderWith([
          { file_type: 'bill_of_lading', file_link: 'https://x/old.pdf', uploaded_at: '2026-05-01T10:00:00Z' },
        ])];
      },
    },
  });

  const summary = await service.runOnce({ referenceMs: Date.parse('2026-06-20T00:00:00Z') });

  assert.equal(summary.sent, 0);
  assert.equal(summary.backfillSuppressed, 1);
  assert.equal(calls.sent.length, 0);
  assert.equal(calls.claimed.length, 0);
});

test('respects DATATRUCK_DOC_SINCE override for the cutoff', async () => {
  const { service, calls } = loadService({
    config: { datatruckDocSinceIso: '2026-06-10T00:00:00Z' },
    directory: [driverGroup],
    datatruck: {
      async fetchOrdersByDeliveryWindow() {
        return [orderWith([
          // After activation (2026-06-01) but before the SINCE override → suppressed.
          { file_type: 'bill_of_lading', file_link: 'https://x/mid.pdf', uploaded_at: '2026-06-05T10:00:00Z' },
        ])];
      },
    },
  });

  const summary = await service.runOnce({ referenceMs: Date.parse('2026-06-20T00:00:00Z') });
  assert.equal(summary.backfillSuppressed, 1);
  assert.equal(calls.sent.length, 0);
});

test('records skipped_no_group when no active driver group matches', async () => {
  const { service, calls } = loadService({
    directory: [], // empty directory → no match
    datatruck: {
      async fetchOrdersByDeliveryWindow() {
        return [orderWith([
          { file_type: 'bill_of_lading', file_link: 'https://x/bol.pdf', uploaded_at: '2026-06-15T10:00:00Z' },
        ], { truck__unit_number: '9999', driver__full_name: 'Nobody Here' })];
      },
    },
  });

  const summary = await service.runOnce({ referenceMs: Date.parse('2026-06-20T00:00:00Z') });
  assert.equal(summary.sent, 0);
  assert.equal(summary.skippedNoGroup, 1);
  assert.equal(calls.markedSkipped.length, 1);
  assert.equal(calls.sent.length, 0);
});

test('ignores document types other than BOL and POD without claiming them', async () => {
  const { service, calls } = loadService({
    directory: [driverGroup],
    datatruck: {
      async fetchOrdersByDeliveryWindow() {
        return [orderWith([
          { file_type: 'rate_confirmation', file_link: 'https://x/rc.pdf', uploaded_at: '2026-06-15T10:00:00Z' },
          { file_type: 'commercial_invoice', file_link: 'https://x/ci.pdf', uploaded_at: '2026-06-15T10:00:00Z' },
        ])];
      },
    },
  });

  const summary = await service.runOnce({ referenceMs: Date.parse('2026-06-20T00:00:00Z') });
  assert.equal(summary.documentsScanned, 0);
  assert.equal(calls.sent.length, 0);
  assert.equal(calls.backfill.length, 0);
});

test('send guard rejects unsupported document types before calling Telegram', async () => {
  const { service, calls } = loadService({ directory: [driverGroup] });

  await assert.rejects(
    service.sendDocumentToGroup('-1002614', {
      fileType: 'rate_confirmation',
      fileLink: 'https://x/rate.pdf',
    }),
    /Refusing to send unsupported document type/
  );
  assert.equal(calls.sent.length, 0);
});

test('an older DATATRUCK_DOC_SINCE cannot release documents from before activation', async () => {
  const { service, calls } = loadService({
    config: { datatruckDocSinceIso: '2026-05-01T00:00:00Z' },
    directory: [driverGroup],
    datatruck: {
      async fetchOrdersByDeliveryWindow() {
        return [orderWith([
          { file_type: 'proof_of_delivery', file_link: 'https://x/old-pod.pdf', uploaded_at: '2026-05-15T10:00:00Z' },
        ])];
      },
    },
  });

  const summary = await service.runOnce({ referenceMs: Date.parse('2026-06-20T00:00:00Z') });
  assert.equal(summary.backfillSuppressed, 1);
  assert.equal(calls.claimed.length, 0);
  assert.equal(calls.sent.length, 0);
});

test('marks failed (not sent) when delivery throws', async () => {
  const { service, calls } = loadService({
    directory: [driverGroup],
    permanentSendError: true,
    telegram: {
      async sendDocument() { throw new Error('boom'); },
    },
    datatruck: {
      async fetchOrdersByDeliveryWindow() {
        return [orderWith([
          { file_type: 'bill_of_lading', file_link: 'https://x/bol.pdf', uploaded_at: '2026-06-15T10:00:00Z' },
        ])];
      },
    },
  });

  const summary = await service.runOnce({ referenceMs: Date.parse('2026-06-20T00:00:00Z') });
  assert.equal(summary.failed, 1);
  assert.equal(summary.sent, 0);
  assert.equal(calls.markedFailed.length, 1);
});

test('runOnce reports not configured when Datatruck is off', async () => {
  const { service } = loadService({ datatruck: { isConfigured() { return false; } } });
  const summary = await service.runOnce();
  assert.equal(summary.configured, false);
});
