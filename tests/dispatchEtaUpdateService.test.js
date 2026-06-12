const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function loadServiceWithMocks({
  dbMock = {},
  liveLocationMock = {},
  pinnedContextMock = {},
  etaRoutingMock = {},
} = {}) {
  const servicePath = path.resolve(__dirname, '../services/dispatchEtaUpdateService.js');
  const dbPath = path.resolve(__dirname, '../database/db.js');
  const liveLocationPath = path.resolve(__dirname, '../services/liveLocationResolver.js');
  const pinnedContextPath = path.resolve(__dirname, '../services/dispatchPinnedContextService.js');
  const etaRoutingPath = path.resolve(__dirname, '../services/etaRoutingService.js');
  const configPath = path.resolve(__dirname, '../config/config.js');

  delete require.cache[servicePath];
  delete require.cache[dbPath];
  delete require.cache[liveLocationPath];
  delete require.cache[pinnedContextPath];
  delete require.cache[etaRoutingPath];
  delete require.cache[configPath];

  require.cache[configPath] = {
    exports: { dispatchEtaTestGroupId: '-100test' },
  };

  require.cache[dbPath] = { exports: dbMock };
  require.cache[liveLocationPath] = { exports: liveLocationMock };
  require.cache[pinnedContextPath] = { exports: pinnedContextMock };
  require.cache[etaRoutingPath] = { exports: etaRoutingMock };

  return require(servicePath);
}

test('buildEtaMessage includes partial details when ETA is unavailable', () => {
  const service = loadServiceWithMocks({
    liveLocationMock: { resolveLiveLocationForGroupTitle: async () => null },
    pinnedContextMock: {
      readLoadContextWithFallbacks: async () => null,
      NO_CURRENT_LOAD_INFO_MESSAGE: 'No information about the current load is found',
    },
    etaRoutingMock: { calculateEtaToDestination: async () => null },
  });

  const message = service.buildEtaMessage({
    context: {
      deliverySummary: '5151 E RAINES RD, Memphis, TN 38118 | 04/30/2026 08:00',
      destinationQuery: '',
    },
    location: {
      address: '11892 General Drive, Charlotte, NC 28273',
      speedMilesPerHour: 0,
      pingAgeMinutes: 0,
    },
    source: 'Samsara',
    eta: null,
    etaError: 'Could not calculate route ETA with current destination/location.',
  });

  assert.match(message, /<blockquote expandable>/);
  assert.match(message, /Current update/);
  assert.match(message, /Delivery location/);
  assert.match(message, /Current location/);
  assert.match(message, /ETA<\/b>: Unavailable - Could not calculate route ETA/);
});

test('resolveDispatchEtaSnapshotForGroup returns partial snapshot when route ETA cannot be calculated', async () => {
  const service = loadServiceWithMocks({
    liveLocationMock: {
      resolveLiveLocationForGroupTitle: async () => ({
        location: {
          latitude: 35.0,
          longitude: -90.0,
          address: 'Memphis, TN',
          speedMilesPerHour: 52,
          pingAgeMinutes: 2,
        },
        source: 'EVO ELD (fallback)',
      }),
    },
    pinnedContextMock: {
      readLoadContextWithFallbacks: async () => ({
        pickupSummary: 'Charlotte, NC',
        deliverySummary: 'Memphis, TN',
        destinationQuery: '5151 E RAINES RD, Memphis, TN 38118',
        source: 'pinned-text+ai',
      }),
      NO_CURRENT_LOAD_INFO_MESSAGE: 'No information about the current load is found',
    },
    etaRoutingMock: {
      calculateEtaToDestination: async () => null,
    },
  });

  const snapshot = await service.resolveDispatchEtaSnapshotForGroup({
    telegram: {
      getChat: async () => ({ title: 'WENZE UNIT # 07 EL HADJI THIAM (COMPANY DRIVER)' }),
    },
    group: {
      id: 77,
      group_name: 'WENZE UNIT # 07 EL HADJI THIAM (COMPANY DRIVER)',
      telegram_group_id: -1003891925043,
    },
  });

  assert.equal(snapshot.context.destinationQuery, '5151 E RAINES RD, Memphis, TN 38118');
  assert.equal(snapshot.source, 'EVO ELD (fallback)');
  assert.equal(snapshot.eta, null);
  assert.match(snapshot.etaError, /Could not calculate route ETA/i);
});

test('resolveDispatchEtaSnapshotForGroup falls back to cached load context when pinned parsing fails', async () => {
  const notFound = new Error('No information about the current load is found');
  notFound.code = 'LOAD_CONTEXT_NOT_FOUND';

  const service = loadServiceWithMocks({
    liveLocationMock: {
      resolveLiveLocationForGroupTitle: async () => ({
        location: {
          latitude: 35.1,
          longitude: -89.9,
          address: 'Near Memphis, TN',
          speedMilesPerHour: 0,
          pingAgeMinutes: 4,
        },
        source: 'TT ELD (fallback)',
      }),
    },
    pinnedContextMock: {
      readLoadContextWithFallbacks: async () => {
        throw notFound;
      },
      NO_CURRENT_LOAD_INFO_MESSAGE: 'No information about the current load is found',
    },
    etaRoutingMock: {
      calculateEtaToDestination: async () => ({
        remainingMiles: 618,
        etaMinutes: 695,
        etaChicagoLabel: '04/30/2026 00:40',
      }),
    },
  });

  const snapshot = await service.resolveDispatchEtaSnapshotForGroup({
    telegram: { getChat: async () => ({ title: 'Unit 07' }) },
    group: { id: 7, group_name: 'Unit 07', telegram_group_id: -1007 },
    previousSignature: 'abc',
    cachedDestinationQuery: '5151 E RAINES RD, Memphis, TN 38118',
    cachedPickup: 'Charlotte, NC',
    cachedDelivery: 'Memphis, TN',
  });

  assert.equal(snapshot.context.source, 'cache');
  assert.equal(snapshot.context.destinationQuery, '5151 E RAINES RD, Memphis, TN 38118');
  assert.equal(snapshot.eta.remainingMiles, 618);
});

test('resolveDispatchEtaSnapshotForGroup throws LOAD_CONTEXT_NOT_FOUND when no load context exists anywhere', async () => {
  const notFound = new Error('No information about the current load is found');
  notFound.code = 'LOAD_CONTEXT_NOT_FOUND';

  const service = loadServiceWithMocks({
    liveLocationMock: {
      resolveLiveLocationForGroupTitle: async () => ({
        location: { latitude: 35.0, longitude: -90.0 },
        source: 'Samsara',
      }),
    },
    pinnedContextMock: {
      readLoadContextWithFallbacks: async () => {
        throw notFound;
      },
      NO_CURRENT_LOAD_INFO_MESSAGE: 'No information about the current load is found',
    },
    etaRoutingMock: { calculateEtaToDestination: async () => null },
  });

  await assert.rejects(
    () => service.resolveDispatchEtaSnapshotForGroup({
      telegram: { getChat: async () => ({ title: 'Unit 99' }) },
      group: { id: 99, group_name: 'Unit 99', telegram_group_id: -10099 },
    }),
    (err) => err?.code === 'LOAD_CONTEXT_NOT_FOUND'
  );
});

test('sendDriverStatusSnapshot passes interactive=true to readLoadContextWithFallbacks', async () => {
  const readCalls = [];
  const service = loadServiceWithMocks({
    liveLocationMock: {
      resolveLiveLocationForGroupTitle: async () => ({
        location: { latitude: 35.0, longitude: -90.0, address: 'Memphis', speedMilesPerHour: 0, pingAgeMinutes: 1 },
        source: 'Samsara',
      }),
    },
    pinnedContextMock: {
      readLoadContextWithFallbacks: async (opts) => {
        readCalls.push(opts);
        return {
          pickupSummary: 'Charlotte, NC',
          deliverySummary: 'Memphis, TN',
          destinationQuery: '5151 E RAINES RD, Memphis, TN 38118',
          source: 'pinned-text+ai',
        };
      },
      NO_CURRENT_LOAD_INFO_MESSAGE: 'No information about the current load is found',
    },
    etaRoutingMock: {
      calculateEtaToDestination: async () => ({
        remainingMiles: 100,
        etaMinutes: 120,
        etaChicagoLabel: '04/30/2026 00:40',
      }),
    },
  });

  const telegram = {
    sendMessage: async () => {},
    getChat: async () => ({ title: 'Unit 07' }),
  };

  await service.sendDriverStatusSnapshot({
    telegram,
    driverGroup: { id: 7, group_name: 'Unit 07', telegram_group_id: -1007 },
    destinationChatId: -1007,
    interactive: true,
  });

  assert.equal(readCalls.length, 1);
  assert.equal(readCalls[0].interactive, true);
});

test('sendDriverStatusSnapshot defaults interactive=false for scheduler-style calls', async () => {
  const readCalls = [];
  const service = loadServiceWithMocks({
    liveLocationMock: {
      resolveLiveLocationForGroupTitle: async () => ({
        location: { latitude: 35.0, longitude: -90.0 },
        source: 'Samsara',
      }),
    },
    pinnedContextMock: {
      readLoadContextWithFallbacks: async (opts) => {
        readCalls.push(opts);
        return {
          pickupSummary: 'Charlotte, NC',
          deliverySummary: 'Memphis, TN',
          destinationQuery: '5151 E RAINES RD, Memphis, TN 38118',
          source: 'pinned-text+ai',
        };
      },
      NO_CURRENT_LOAD_INFO_MESSAGE: 'No information about the current load is found',
    },
    etaRoutingMock: { calculateEtaToDestination: async () => null },
  });

  await service.resolveDispatchEtaSnapshotForGroup({
    telegram: { getChat: async () => ({ title: 'Unit 07' }) },
    group: { id: 7, group_name: 'Unit 07', telegram_group_id: -1007 },
  });

  assert.equal(readCalls.length, 1);
  assert.equal(readCalls[0].interactive, false);
});

test('sendDriverStatusSnapshot sends no-load-info message on LOAD_CONTEXT_NOT_FOUND', async () => {
  const notFound = new Error('No information about the current load is found');
  notFound.code = 'LOAD_CONTEXT_NOT_FOUND';

  const messages = [];
  const service = loadServiceWithMocks({
    liveLocationMock: { resolveLiveLocationForGroupTitle: async () => null },
    pinnedContextMock: {
      readLoadContextWithFallbacks: async () => { throw notFound; },
      NO_CURRENT_LOAD_INFO_MESSAGE: 'No information about the current load is found',
    },
    etaRoutingMock: { calculateEtaToDestination: async () => null },
  });

  const result = await service.sendDriverStatusSnapshot({
    telegram: {
      getChat: async () => ({ title: 'Unit 99' }),
      sendMessage: async (_chatId, text) => { messages.push(text); },
    },
    driverGroup: { id: 99, group_name: 'Unit 99', telegram_group_id: -10099 },
    destinationChatId: -10099,
    targetMode: 'test',
    interactive: true,
  });

  assert.equal(result.noLoadInfo, true);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /No information about the current load is found/);
});
