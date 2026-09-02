/**
 * Turning chosen load text INTO a load context with two AI providers.
 *
 * These cases exist because the providers fail in awkward ways: Groq 429
 * storms, Gemini missing its key, both failing at once, and visual media that
 * each provider reads differently. The behaviours pinned here are that the
 * RACE returns whichever provider resolves first, that a slow provider cannot
 * hold the answer hostage, that a regex destination is the last resort rather
 * than an error, and that concurrent calls settle without unhandled
 * rejections.
 *
 * The concurrency case is deliberately a hammer, not a single call — a losing
 * racer's rejection is only observable under load.
 *
 * Which context to extract FROM is a separate concern; see
 * dispatchPinnedContext.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { loadPinnedContextWithMocks } = require('./helpers/pinnedContextHarness');

/**
 * A complete, valid extraction result — pickup, delivery, both datetimes and a
 * street-level destination_query. Cases below return it from one provider or
 * the other to assert WHICH provider's answer surfaced.
 */
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
