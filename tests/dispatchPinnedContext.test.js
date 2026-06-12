const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function loadPinnedContextWithMocks({ parserMock, dbMock, groqMock, geminiMock } = {}) {
  const servicePath = path.resolve(__dirname, '../services/dispatchPinnedContextService.js');
  const parserPath = path.resolve(__dirname, '../server/services/dispatchParserService.js');
  const dbPath = path.resolve(__dirname, '../database/db.js');
  const groqPath = path.resolve(__dirname, '../services/groqClient.js');
  const geminiPath = path.resolve(__dirname, '../services/geminiClient.js');

  delete require.cache[servicePath];
  delete require.cache[parserPath];
  delete require.cache[dbPath];
  delete require.cache[groqPath];
  delete require.cache[geminiPath];

  const realGroq = require('../services/groqClient');
  const realGemini = require('../services/geminiClient');

  require.cache[groqPath] = {
    exports: {
      ...realGroq,
      ...(groqMock || {}),
      callGroqWithFallback: groqMock?.callGroqWithFallback || realGroq.callGroqWithFallback,
    },
  };
  require.cache[geminiPath] = {
    exports: {
      ...realGemini,
      ...(geminiMock || {}),
      GEMINI_API_KEY: geminiMock?.GEMINI_API_KEY !== undefined
        ? geminiMock.GEMINI_API_KEY
        : (process.env.GEMINI_API_KEY || 'test-gemini-key'),
      callGeminiGenerateContent: geminiMock?.callGeminiGenerateContent || realGemini.callGeminiGenerateContent,
      getPinnedContextGeminiModels: geminiMock?.getPinnedContextGeminiModels
        || realGemini.getPinnedContextGeminiModels,
    },
  };
  require.cache[parserPath] = {
    exports: parserMock || {
      extractRateConRawTextFromFile: async () => ({ text: '', usedPdfOcr: false }),
    },
  };
  const defaultDb = {
    getGroupPinnedMessageSnapshot: async () => null,
    getChatLogsForGroup: async () => [],
    getGroupRecentLoads: async () => [],
    hasGroupRecentLoadForMessage: async () => false,
    hasAnyGroupRecentLoadForMessages: async () => false,
  };
  require.cache[dbPath] = {
    exports: { ...defaultDb, ...(dbMock || {}) },
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
  const originalGroqKey = process.env.GROQ_API_KEY;
  try {
    // Service throws before fetch unless a key is set; the mock supplies Groq-style JSON.
    process.env.GROQ_API_KEY = 'test-mock-groq-key';
    delete require.cache[require.resolve('../services/groqClient')];
    global.fetch = async (_url, options = {}) => {
      const body = JSON.parse(String(options.body || '{}'));
      if (body?.model) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify({
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
          }),
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
            // Avoid "Live/Live" here — it matches isLikelyStaleStatusMessage and is skipped as stale traffic.
            message_text: 'RateConfirmation (1).pdf, Load # 370550 PA>OH',
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
    if (originalGroqKey === undefined) {
      delete process.env.GROQ_API_KEY;
    } else {
      process.env.GROQ_API_KEY = originalGroqKey;
    }
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

const VALID_PINNED_JSON = {
  pickup_location: 'Charlotte, NC 28273',
  pickup_datetime: '04/29/2026 09:00',
  delivery_location: 'Memphis, TN 38118',
  delivery_datetime: '04/30/2026 08:00',
  destination_query: '5151 E RAINES RD, Memphis, TN 38118',
  notes: '',
};

test('buildLoadContextFromText uses Gemini without waiting for slow Groq 429 storm', async () => {
  const service = loadPinnedContextWithMocks({
    groqMock: {
      callGroqWithFallback: async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        const err = new Error('Groq API 429: Rate limit reached');
        err.status = 429;
        throw err;
      },
    },
    geminiMock: {
      callGeminiGenerateContent: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          text: JSON.stringify(VALID_PINNED_JSON),
          model: 'gemini-test',
          payload: {},
        };
      },
    },
  });

  const startedAt = Date.now();
  const context = await service.buildLoadContextFromText({
    pinnedText: 'Load #370550 PA>OH DEL: Memphis, TN 38118',
    interactive: true,
  });
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed < 200, `expected race finish under 200ms, took ${elapsed}ms`);
  assert.equal(context.aiModel, 'gemini-test');
  assert.equal(context.destinationQuery, '5151 E RAINES RD, Memphis, TN 38118');
});

test('buildLoadContextFromText prefers Groq when it resolves before Gemini', async () => {
  const service = loadPinnedContextWithMocks({
    groqMock: {
      callGroqWithFallback: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { text: JSON.stringify(VALID_PINNED_JSON), model: 'groq-fast' };
      },
    },
    geminiMock: {
      callGeminiGenerateContent: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return {
          text: JSON.stringify({
            ...VALID_PINNED_JSON,
            destination_query: 'wrong destination',
          }),
          model: 'gemini-slow',
          payload: {},
        };
      },
    },
  });

  const context = await service.buildLoadContextFromText({
    pinnedText: 'Load text',
    interactive: true,
  });

  assert.equal(context.aiModel, 'groq-fast');
  assert.equal(context.destinationQuery, '5151 E RAINES RD, Memphis, TN 38118');
});

test('buildLoadContextFromText passes interactive Groq opts only when interactive is true', async () => {
  const groqCalls = [];
  const service = loadPinnedContextWithMocks({
    groqMock: {
      callGroqWithFallback: async (_prompt, opts) => {
        groqCalls.push(opts);
        return { text: JSON.stringify(VALID_PINNED_JSON), model: 'groq-test' };
      },
    },
    geminiMock: {
      GEMINI_API_KEY: '',
      callGeminiGenerateContent: async () => {
        throw new Error('Gemini should not run');
      },
    },
  });

  await service.buildLoadContextFromText({ pinnedText: 'Load text', interactive: true });
  await service.buildLoadContextFromText({ pinnedText: 'Load text 2', interactive: false });

  assert.equal(groqCalls.length, 2);
  assert.equal(groqCalls[0].maxRetryWaitMs, 8000);
  assert.equal(groqCalls[0].timeoutMs, 20000);
  assert.equal(groqCalls[1].maxRetryWaitMs, undefined);
  assert.equal(groqCalls[1].timeoutMs, undefined);
});

test('buildLoadContextFromText falls back to regex destination when both AI providers fail', async () => {
  const service = loadPinnedContextWithMocks({
    groqMock: {
      callGroqWithFallback: async () => {
        throw new Error('Groq API 429: Rate limit reached');
      },
    },
    geminiMock: {
      callGeminiGenerateContent: async () => {
        throw new Error('Gemini quota exhausted');
      },
    },
  });

  const context = await service.buildLoadContextFromText({
    pinnedText: 'Load: 301512\nPU: Woodstock, AL 35188\nDEL: ANDERSON, TN 46013',
    interactive: true,
  });

  assert.equal(context.aiModel, '');
  assert.equal(context.destinationQuery, 'ANDERSON, TN 46013');
  assert.equal(context.loadInfoComplete, false);
  assert.equal(context.source, 'pinned-text+ai');
});

test('buildLoadContextFromText skips Gemini racer when GEMINI_API_KEY is missing', async () => {
  let geminiCalls = 0;
  const service = loadPinnedContextWithMocks({
    groqMock: {
      callGroqWithFallback: async () => ({ text: JSON.stringify(VALID_PINNED_JSON), model: 'groq-only' }),
    },
    geminiMock: {
      GEMINI_API_KEY: '',
      callGeminiGenerateContent: async () => {
        geminiCalls += 1;
        throw new Error('should not be called');
      },
    },
  });

  const context = await service.buildLoadContextFromText({
    pinnedText: 'Load text',
    interactive: true,
  });

  assert.equal(geminiCalls, 0);
  assert.equal(context.aiModel, 'groq-only');
});

test('buildLoadContextFromText concurrency hammer settles without unhandled rejections', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);

  try {
    const service = loadPinnedContextWithMocks({
      groqMock: {
        callGroqWithFallback: async () => {
          const delay = Math.floor(Math.random() * 40);
          await new Promise((resolve) => setTimeout(resolve, delay));
          if (Math.random() < 0.4) {
            throw new Error('Groq API 429: Rate limit reached');
          }
          return { text: JSON.stringify(VALID_PINNED_JSON), model: 'groq-hammer' };
        },
      },
      geminiMock: {
        callGeminiGenerateContent: async () => {
          const delay = Math.floor(Math.random() * 40);
          await new Promise((resolve) => setTimeout(resolve, delay));
          if (Math.random() < 0.3) {
            throw new Error('Gemini transient');
          }
          return {
            text: JSON.stringify(VALID_PINNED_JSON),
            model: 'gemini-hammer',
            payload: {},
          };
        },
      },
    });

    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) => service.buildLoadContextFromText({
        pinnedText: `Load #${i} DEL: Memphis, TN 38118`,
        interactive: true,
      }))
    );

    assert.equal(results.length, 25);
    for (const result of results) {
      assert.ok(result.destinationQuery);
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(unhandled.length, 0);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('buildLoadContextFromText merges Groq and Gemini for visual media', async () => {
  const service = loadPinnedContextWithMocks({
    groqMock: {
      callGroqWithFallback: async () => ({
        text: JSON.stringify({
          ...VALID_PINNED_JSON,
          delivery_location: '',
          destination_query: '',
        }),
        model: 'groq-visual',
      }),
    },
    geminiMock: {
      callGeminiGenerateContent: async () => ({
        text: JSON.stringify(VALID_PINNED_JSON),
        model: 'gemini-visual',
        payload: {},
      }),
    },
  });

  const context = await service.buildLoadContextFromText({
    pinnedText: 'Rate con attached',
    sourceFile: {
      buffer: Buffer.from('%PDF-1.4'),
      mimetype: 'application/pdf',
      originalname: 'rate.pdf',
    },
    interactive: true,
  });

  assert.equal(context.destinationQuery, '5151 E RAINES RD, Memphis, TN 38118');
  assert.match(context.aiModel, /groq-visual/);
  assert.match(context.aiModel, /gemini-visual/);
});
