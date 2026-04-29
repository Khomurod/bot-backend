const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function loadPinnedContextWithMocks(parserMock) {
  const servicePath = path.resolve(__dirname, '../services/dispatchPinnedContextService.js');
  const parserPath = path.resolve(__dirname, '../server/services/dispatchParserService.js');

  delete require.cache[servicePath];
  delete require.cache[parserPath];
  require.cache[parserPath] = {
    exports: parserMock || {
      extractRateConRawTextFromFile: async () => ({ text: '', usedPdfOcr: false }),
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
