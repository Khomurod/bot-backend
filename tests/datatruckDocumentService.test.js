const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

/**
 * End-to-end tests for the BOL/POD forwarding service's runOnce(): real DataTruck
 * order extraction + real driver-name → group matching, with the settings store,
 * Telegram bot, and delivery DB helper mocked via require.cache. Complements
 * bolPodRouting.test.js (which unit-tests the routing decision matrix).
 *
 * Default settings here: feature enabled, driver_group mode — so runOnce forwards
 * to the matched driver group exactly as the pre-admin-control service did.
 */
function loadService({
  config: cfg = {},
  datatruck = {},
  docsDb = {},
  directory = [],
  telegram = {},
  permanentSendError = false,
  settings = {},
} = {}) {
  const servicePath = path.resolve(__dirname, '../services/datatruckDocumentService.js');
  const configPath = path.resolve(__dirname, '../config/config.js');
  const telegrafPath = require.resolve('telegraf');
  const botPath = path.resolve(__dirname, '../bot/bot.js');
  const htmlPath = path.resolve(__dirname, '../services/telegramHtml.js');
  const datatruckPath = path.resolve(__dirname, '../services/datatruckApiService.js');
  const docsDbPath = path.resolve(__dirname, '../database/datatruckDocuments.js');
  const directoryPath = path.resolve(__dirname, '../services/driverGroupDirectoryService.js');
  const settingsPath = path.resolve(__dirname, '../database/bolPodForwardingSettings.js');

  delete require.cache[servicePath];

  const calls = {
    sent: [], backfill: [], upserts: [], claimed: [],
    markedSent: [], markedFailed: [], markedSkipped: [],
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
    bolPodAiFallbackEnabled: false,
    ...cfg,
  };

  const settingsMock = {
    enabled: true,
    deliveryMode: 'driver_group',
    centralGroupId: null,
    documentTypeMode: 'both',
    uncertainDocumentPolicy: 'do_not_send',
    ...settings,
  };

  const datatruckMock = {
    isConfigured() { return true; },
    async fetchOrdersByDeliveryWindow() { return []; },
    ...datatruck,
  };
  if (typeof datatruckMock.fetchOrdersByDocumentWindow !== 'function') {
    datatruckMock.fetchOrdersByDocumentWindow = (...args) => datatruckMock.fetchOrdersByDeliveryWindow(...args);
  }

  let rowSeq = 0;
  const docsDbMock = {
    async ensureActivationTime() { return new Date('2026-06-01T00:00:00Z'); },
    async recordBackfillSuppressed(meta) { calls.backfill.push(meta); return true; },
    async upsertDelivery(meta) {
      rowSeq += 1;
      calls.upserts.push(meta);
      return { row: { id: rowSeq, status: 'pending', central_status: 'pending', ...meta }, isNew: true };
    },
    async claimDestination(id, dest) { calls.claimed.push({ id, dest }); return { id, dest }; },
    async markDestinationSent(id, dest, info) { calls.markedSent.push({ id, dest, info }); return { id }; },
    async markDestinationFailed(id, dest, error) { calls.markedFailed.push({ id, dest, error }); return { id }; },
    async markDestinationSkipped(id, dest, skip) { calls.markedSkipped.push({ id, dest, skip }); return { id }; },
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
  require.cache[directoryPath] = { exports: { listCanonicalDriverGroups: async () => directory } };
  require.cache[settingsPath] = { exports: { getBolPodConfig: async () => settingsMock } };

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

test('driver_group mode: forwards a new BOL by driver name (truck number ignored)', async () => {
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

  assert.equal(summary.driverSent, 1);
  assert.equal(summary.backfillSuppressed, 0);
  assert.equal(calls.sent.length, 1);
  assert.equal(calls.sent[0].chatId, '-1002614');
  assert.equal(calls.sent[0].file.kind, 'url');
  assert.equal(
    calls.sent[0].file.url,
    'https://tms-datatruck.s3-accelerate.amazonaws.com/static/2026/6/15/uuid/bol_scan.pdf'
  );
  assert.equal(calls.sent[0].extra.parse_mode, 'HTML');
  assert.match(calls.sent[0].extra.caption, /Bill of Lading/);
  const driverSent = calls.markedSent.find((m) => m.dest === 'driver');
  assert.ok(driverSent);
  assert.equal(driverSent.info.telegramGroupId, '-1002614');
  assert.equal(driverSent.info.matchedBy, 'name');
});

test('routes BOL to the uploader driver group by uploader name', async () => {
  const { service, calls } = loadService({
    directory: [driverGroup, uploaderGroup],
    datatruck: {
      async fetchOrdersByDeliveryWindow() {
        return [orderWith([
          { file_type: 'bill_of_lading', file_link: 'https://x/bol.pdf', uploaded_at: '2026-06-15T10:00:00Z', uploaded_by: { full_name: 'Jane Driver' } },
        ])];
      },
    },
  });

  const summary = await service.runOnce({ referenceMs: Date.parse('2026-06-20T00:00:00Z') });

  assert.equal(summary.driverSent, 1);
  assert.equal(calls.sent[0].chatId, '-1000008');
  const driverSent = calls.markedSent.find((m) => m.dest === 'driver');
  assert.equal(driverSent.info.groupId, 20);
  assert.equal(driverSent.info.matchedBy, 'name');
});

test('forwards a new POD by uploader driver name', async () => {
  const { service, calls } = loadService({
    directory: [driverGroup, uploaderGroup],
    datatruck: {
      async fetchOrdersByDeliveryWindow() {
        return [orderWith([
          { file_type: 'proof_of_delivery', file_link: '2026/6/15/uuid/pod_scan.pdf', uploaded_at: '2026-06-15T11:00:00Z', uploaded_by: 'Jane Driver' },
        ], { truck__unit_number: '9999' })];
      },
    },
  });

  const summary = await service.runOnce({ referenceMs: Date.parse('2026-06-20T00:00:00Z') });

  assert.equal(summary.driverSent, 1);
  assert.equal(calls.sent[0].chatId, '-1000008');
  assert.match(calls.sent[0].extra.caption, /Proof of Delivery/);
  assert.equal(calls.sent[0].file.filename, 'POD_L-500.pdf');
});

test('sends BOL and POD from the same order as two idempotent deliveries', async () => {
  const { service, calls } = loadService({
    directory: [driverGroup],
    datatruck: {
      async fetchOrdersByDeliveryWindow() {
        return [orderWith([
          { file_type: 'bill_of_lading', file_link: 'https://x/bol.pdf', uploaded_at: '2026-06-15T10:00:00Z' },
          { file_type: 'proof_of_delivery', file_link: 'https://x/pod.pdf', uploaded_at: '2026-06-15T11:00:00Z' },
        ])];
      },
    },
  });

  const summary = await service.runOnce({ referenceMs: Date.parse('2026-06-20T00:00:00Z') });

  assert.equal(summary.documentsScanned, 2);
  assert.equal(summary.driverSent, 2);
  assert.equal(calls.upserts.length, 2);
  assert.equal(calls.sent.length, 2);
  assert.notEqual(calls.upserts[0].signature, calls.upserts[1].signature);
  assert.deepEqual(calls.sent.map((call) => call.file.filename), ['BOL_L-500.pdf', 'POD_L-500.pdf']);
});

test('suppresses documents uploaded before the activation cutoff', async () => {
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

  assert.equal(summary.driverSent, 0);
  assert.equal(summary.backfillSuppressed, 1);
  assert.equal(calls.sent.length, 0);
  assert.equal(calls.upserts.length, 0);
});

test('respects DATATRUCK_DOC_SINCE override for the cutoff', async () => {
  const { service, calls } = loadService({
    config: { datatruckDocSinceIso: '2026-06-10T00:00:00Z' },
    directory: [driverGroup],
    datatruck: {
      async fetchOrdersByDeliveryWindow() {
        return [orderWith([
          { file_type: 'bill_of_lading', file_link: 'https://x/mid.pdf', uploaded_at: '2026-06-05T10:00:00Z' },
        ])];
      },
    },
  });

  const summary = await service.runOnce({ referenceMs: Date.parse('2026-06-20T00:00:00Z') });
  assert.equal(summary.backfillSuppressed, 1);
  assert.equal(calls.sent.length, 0);
});

test('missing driver group → skipped_no_group, nothing sent', async () => {
  const { service, calls } = loadService({
    directory: [],
    datatruck: {
      async fetchOrdersByDeliveryWindow() {
        return [orderWith([
          { file_type: 'bill_of_lading', file_link: 'https://x/bol.pdf', uploaded_at: '2026-06-15T10:00:00Z' },
        ], { truck__unit_number: '9999', driver__full_name: 'Nobody Here' })];
      },
    },
  });

  const summary = await service.runOnce({ referenceMs: Date.parse('2026-06-20T00:00:00Z') });
  assert.equal(summary.driverSent, 0);
  assert.equal(summary.skippedNoGroup, 1);
  assert.ok(calls.markedSkipped.some((m) => m.dest === 'driver' && m.skip === 'skipped_no_group'));
  assert.equal(calls.sent.length, 0);
});

test('ignores non-BOL/POD document types without tracking them', async () => {
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

test('document-type filter: BOL-only mode does not send a POD', async () => {
  const { service, calls } = loadService({
    directory: [driverGroup],
    settings: { documentTypeMode: 'bol' },
    datatruck: {
      async fetchOrdersByDeliveryWindow() {
        return [orderWith([
          { file_type: 'proof_of_delivery', file_link: 'https://x/pod.pdf', uploaded_at: '2026-06-15T10:00:00Z' },
        ])];
      },
    },
  });

  const summary = await service.runOnce({ referenceMs: Date.parse('2026-06-20T00:00:00Z') });
  assert.equal(summary.driverSent, 0);
  assert.equal(summary.skippedType, 1);
  assert.equal(calls.sent.length, 0);
});

test('send guard rejects unsupported document types before calling Telegram', async () => {
  const { service, calls } = loadService({ directory: [driverGroup] });

  await assert.rejects(
    service.sendDocumentToGroup('-1002614', { fileType: 'rate_confirmation', fileLink: 'https://x/rate.pdf' }),
    /Refusing to send unsupported document type/
  );
  assert.equal(calls.sent.length, 0);
});

test('marks failed (not sent) when delivery throws', async () => {
  const { service, calls } = loadService({
    directory: [driverGroup],
    permanentSendError: true,
    telegram: { async sendDocument() { throw new Error('boom'); } },
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
  assert.equal(summary.driverSent, 0);
  assert.ok(calls.markedFailed.some((m) => m.dest === 'driver'));
});

test('runOnce reports not configured when Datatruck is off', async () => {
  const { service } = loadService({ datatruck: { isConfigured() { return false; } } });
  const summary = await service.runOnce();
  assert.equal(summary.configured, false);
});

test('runOnce is a no-op when the feature is disabled (sends nothing)', async () => {
  const { service, calls } = loadService({
    directory: [driverGroup],
    settings: { enabled: false },
    datatruck: {
      async fetchOrdersByDeliveryWindow() {
        return [orderWith([
          { file_type: 'bill_of_lading', file_link: 'https://x/bol.pdf', uploaded_at: '2026-06-15T10:00:00Z' },
        ])];
      },
    },
  });

  const summary = await service.runOnce({ referenceMs: Date.parse('2026-06-20T00:00:00Z') });
  assert.equal(summary.enabled, false);
  assert.equal(calls.sent.length, 0);
});
