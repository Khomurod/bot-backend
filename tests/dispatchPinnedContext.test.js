const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function loadPinnedContextWithMocks({ parserMock, dbMock } = {}) {
  const servicePath = path.resolve(__dirname, '../services/dispatchPinnedContextService.js');
  const parserPath = path.resolve(__dirname, '../server/services/dispatchParserService.js');
  const dbPath = path.resolve(__dirname, '../database/db.js');

  delete require.cache[servicePath];
  delete require.cache[parserPath];
  delete require.cache[dbPath];
  require.cache[parserPath] = {
    exports: parserMock || {
      extractRateConRawTextFromFile: async () => ({ text: '', usedPdfOcr: false }),
    },
  };
  require.cache[dbPath] = {
    exports: dbMock || {
      getGroupPinnedMessageSnapshot: async () => null,
      getChatLogsForGroup: async () => [],
      getGroupRecentLoads: async () => [],
      hasGroupRecentLoadForMessage: async () => false,
      hasAnyGroupRecentLoadForMessages: async () => false,
    },
  };
  return require(servicePath);
}

test('inferDestinationFromPinnedText prefers a city/state/zip and falls back to route shorthand', () => {
  const service = loadPinnedContextWithMocks();
  const withAddress = service.inferDestinationFromPinnedText(
    'Load: 301512\nPU: Woodstock, AL 35188\nDEL: ANDERSON, TN 46013'
  );
  assert.equal(withAddress, 'ANDERSON, TN 46013');

  const fromRouteOnly = service.inferDestinationFromPinnedText('NJ > FL');
  assert.equal(fromRouteOnly, 'FL, USA');
});

test('buildPinnedSignature changes when text or file changes', () => {
  const service = loadPinnedContextWithMocks();
  const base = service.buildPinnedSignature({
    pinnedMessage: { message_id: 10, date: 1, edit_date: 2 },
    text: 'hello',
    fileDescriptor: { fileUniqueId: 'A' },
  });
  const changedText = service.buildPinnedSignature({
    pinnedMessage: { message_id: 10, date: 1, edit_date: 2 },
    text: 'hello world',
    fileDescriptor: { fileUniqueId: 'A' },
  });
  const changedFile = service.buildPinnedSignature({
    pinnedMessage: { message_id: 10, date: 1, edit_date: 2 },
    text: 'hello',
    fileDescriptor: { fileUniqueId: 'B' },
  });

  assert.notEqual(base, changedText);
  assert.notEqual(base, changedFile);
});

test('choosePinnedMessageCandidate prefers latest DB snapshot when pin event timestamp exists', () => {
  const service = loadPinnedContextWithMocks();
  const chosen = service.choosePinnedMessageCandidate({
    chatPinnedMessage: { message_id: 100, date: 1000, text: 'old' },
    snapshotPinnedMessage: { message_id: 200, date: 900, text: 'new pin event' },
    snapshotSourceEventAt: '2026-04-29T20:00:00.000Z',
  });

  assert.equal(chosen.message_id, 200);
});

test('readPinnedLoadContext returns cached values when signature is unchanged', async () => {
  const service = loadPinnedContextWithMocks();
  const telegramMock = {
    async getChat() {
      return {
        pinned_message: {
          message_id: 100,
          date: 10,
          edit_date: 11,
          text: 'Load test text',
        },
      };
    },
  };

  const result = await service.readPinnedLoadContext({
    telegram: telegramMock,
    chatId: -100123,
    previousSignature: service.buildPinnedSignature({
      pinnedMessage: { message_id: 100, date: 10, edit_date: 11 },
      text: 'Load test text',
      fileDescriptor: null,
    }),
    cachedDestinationQuery: 'Anderson, TN 46013',
    cachedPickup: 'Woodstock, AL 35188',
    cachedDelivery: 'Anderson, TN 46013',
  });

  assert.equal(result.source, 'cache');
  assert.equal(result.destinationQuery, 'Anderson, TN 46013');
});

test('readLoadContextWithFallbacks uses latest load-like chat message when no pin exists', async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async (_url, options = {}) => {
      const body = JSON.parse(String(options.body || '{}'));
      if (body?.model) {
        return {
          ok: true,
          async json() {
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      pickup_location: 'Charlotte, NC 28273',
                      pickup_datetime: '04/29/2026 09:00',
                      delivery_location: 'Memphis, TN 38118',
                      delivery_datetime: '04/30/2026 08:00',
                      destination_query: '5151 E RAINES RD, Memphis, TN 38118',
                      notes: '',
                    }),
                  },
                },
              ],
            };
          },
        };
      }
      throw new Error('Unexpected fetch call');
    };

    const service = loadPinnedContextWithMocks({
      dbMock: {
        getGroupPinnedMessageSnapshot: async () => null,
        getChatLogsForGroup: async () => ([
          {
            message_text: '/location',
            created_at: '2026-04-29T22:00:00.000Z',
            sender_name: 'Tom',
            telegram_message_id: '100',
          },
          {
            message_text: 'RateConfirmation (1).pdf, Load # 370550 Live/Live PA>OH',
            created_at: '2026-04-29T21:00:00.000Z',
            sender_name: 'Leo',
            telegram_message_id: '99',
          },
        ]),
      },
    });

    const context = await service.readLoadContextWithFallbacks({
      telegram: {
        async getChat() {
          return {};
        },
      },
      chatId: -100123,
      groupId: 55,
    });

    assert.equal(context.source, 'chat-history+ai');
    assert.equal(context.loadInfoComplete, true);
    assert.equal(context.fallbackLevel, 3);
    assert.equal(context.destinationQuery, '5151 E RAINES RD, Memphis, TN 38118');
  } finally {
    global.fetch = originalFetch;
  }
});

test('readLoadContextWithFallbacks prefers stored recent loads over pinned when stored is complete', async () => {
  const service = loadPinnedContextWithMocks({
    dbMock: {
      getGroupPinnedMessageSnapshot: async () => null,
      getGroupRecentLoads: async () => [
        {
          telegram_message_id: 9001,
          context_signature: 'storedsig',
          pickup_summary: 'Charlotte, NC',
          delivery_summary: 'Memphis, TN',
          destination_query: '5151 E RAINES RD, Memphis, TN 38118',
          caption_preview: 'Load # 1',
          pickup_window_start: null,
          pickup_window_end: null,
          delivery_window_start: null,
          delivery_window_end: null,
          created_at: '2026-04-29T12:00:00.000Z',
          ai_model: 'test-model',
        },
      ],
      hasGroupRecentLoadForMessage: async () => false,
      getChatLogsForGroup: async () => [],
    },
  });

  const context = await service.readLoadContextWithFallbacks({
    telegram: {
      async getChat() {
        return {
          pinned_message: {
            message_id: 8000,
            date: 100,
            edit_date: 101,
            text: 'Different pinned load text',
          },
        };
      },
    },
    chatId: -100123,
    groupId: 77,
  });

  assert.equal(context.source, 'stored-recent-load');
  assert.equal(context.destinationQuery, '5151 E RAINES RD, Memphis, TN 38118');
  assert.equal(context.fallbackLevel, 0);
});

test('readLoadContextWithFallbacks throws canonical message when all fallbacks fail', async () => {
  const service = loadPinnedContextWithMocks({
    dbMock: {
      getGroupPinnedMessageSnapshot: async () => null,
      getChatLogsForGroup: async () => [],
    },
  });

  await assert.rejects(
    service.readLoadContextWithFallbacks({
      telegram: {
        async getChat() {
          return {};
        },
      },
      chatId: -100123,
      groupId: 55,
    }),
    (err) => err.message === 'No information about the current load is found'
  );
});
