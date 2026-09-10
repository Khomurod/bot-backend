/**
 * Translation service for the admin "Send Message" (broadcast) composer.
 *
 * Runs on the app's integrated AI stack, like every other AI feature: one call
 * through the shared client, with cross-provider fallback handled by the router
 * over the roster an administrator configured. There is no Send-Message-specific
 * provider, key or model — this module only builds translation prompts.
 */
const { callGroqWithFallback } = require('./groqClient');
const { isAiAvailable } = require('./ai/registry');

const AI_NOT_CONFIGURED_MESSAGE =
  'AI is not configured. Configure the app’s integrated AI settings first.';

const LANGUAGE_NAMES = {
  ru: 'Russian',
  uz: 'Uzbek',
  en: 'English',
};

const SYSTEM_PROMPT = `You are a professional translator specializing in the trucking and transportation industry.
You translate text for truck drivers who work in the US.
Key requirements:
- Translate naturally for truck drivers
- Preserve ALL HTML formatting tags exactly as they are: <b>, <i>, <u>, <s>, <code>, <pre>, <a href="...">, <tg-spoiler>, <blockquote>
- Preserve all links unchanged
- Do not add any commentary, explanations, or extra text
- Return ONLY the translated text
- For trucking terms like dispatch, deadhead, broker, lane, load — use the most commonly understood terms in the target language`;

/**
 * True when there is a provider Wenze may actually ask.
 *
 * Asked of the ROSTER rather than of the environment. A key that lives only in
 * Admin → Settings → AI is a configured key — the old check would have called
 * translation unavailable and shown the operator "AI is not configured" while
 * their key sat in the database. And the master switch being OFF is a reason to
 * say exactly this, which an env-var check could never see at all.
 */
async function isTranslationAiConfigured() {
  return isAiAvailable();
}

function notConfiguredError() {
  const err = new Error(AI_NOT_CONFIGURED_MESSAGE);
  err.code = 'AI_NOT_CONFIGURED';
  err.statusCode = 503;
  return err;
}

/**
 * Strictly parse the model's JSON response for translateBatch.
 * The previous implementation used a fragile numbered-line parser that
 * silently misaligned translations when the model inserted blank lines or
 * changed prefixes. We now require JSON mode and validate shape + length.
 *
 * Expected shape:
 *   { "translations": ["...", "...", ...] }
 *
 * Exported so it can be unit-tested in isolation.
 */
function parseBatchResponse(rawResponse, expectedCount) {
  if (!rawResponse || typeof rawResponse !== 'string') {
    throw new Error('Empty response from translation API');
  }

  let parsed;
  try {
    parsed = JSON.parse(rawResponse);
  } catch (err) {
    throw new Error(`Translation response is not valid JSON: ${err.message}`);
  }

  const arr = parsed?.translations;
  if (!Array.isArray(arr)) {
    throw new Error('Translation response missing "translations" array');
  }
  if (arr.length !== expectedCount) {
    throw new Error(
      `Translation count mismatch: expected ${expectedCount}, got ${arr.length}`
    );
  }
  // Coerce to strings and strip — model occasionally wraps in whitespace.
  return arr.map((t) => (typeof t === 'string' ? t.trim() : String(t ?? '')));
}

function buildBatchPrompt(textsArray, langName) {
  const userPayload = {
    target_language: langName,
    items: textsArray,
  };
  return (
    `Translate each string in "items" from English into ${langName}. ` +
    `Preserve HTML tags and links exactly. Return ONLY a JSON object with ` +
    `this exact shape:\n\n` +
    `{ "translations": ["<translation of items[0]>", "<translation of items[1]>", ...] }\n\n` +
    `The translations array MUST have exactly ${textsArray.length} entries in the same order.\n\n` +
    `Input:\n${JSON.stringify(userPayload)}`
  );
}

async function translateViaGroq(prompt, expectedCount) {
  const { text } = await callGroqWithFallback(prompt, {
    systemText: SYSTEM_PROMPT,
    temperature: 0.3,
    maxTokens: 4000,
    responseFormat: { type: 'json_object' },
    validateResult: (raw) => {
      try {
        parseBatchResponse(raw, expectedCount);
        return true;
      } catch (err) {
        return { message: err.message };
      }
    },
  });
  return parseBatchResponse(text, expectedCount);
}

/**
 * Translate an array of text blocks to a target language in a single AI
 * call (Groq first, Gemini fallback). Uses JSON response mode so parsing is
 * unambiguous.
 *
 * @param {string[]} textsArray - Array of English source texts
 * @param {string} targetLanguage - Language code: 'ru' or 'uz'
 * @returns {Promise<string[]>} Array of translated texts, 1:1 with input
 */
async function translateBatch(textsArray, targetLanguage) {
  if (!textsArray || textsArray.length === 0) return [];

  const totalLength = textsArray.reduce((sum, t) => sum + (t?.length || 0), 0);
  if (totalLength > 4096) {
    throw new Error('Total text exceeds 4096 character limit');
  }

  const langName = LANGUAGE_NAMES[targetLanguage];
  if (!langName) {
    throw new Error(`Unsupported target language: ${targetLanguage}`);
  }

  if (!(await isTranslationAiConfigured())) {
    throw notConfiguredError();
  }

  console.log(
    `[Translation] translation_requested: lang=${targetLanguage}, batch_size=${textsArray.length}`
  );

  const prompt = buildBatchPrompt(textsArray, langName);

  try {
    // ONE call. Which provider answers is the router's decision, from the roster
    // an administrator configured — not a branch on which environment variable
    // happens to be set.
    const results = await translateViaGroq(prompt, textsArray.length);

    console.log(
      `[Translation] translation_completed: lang=${targetLanguage}, batch_size=${results.length}`
    );
    return results;
  } catch (err) {
    console.error(
      `[Translation] translation_failed: lang=${targetLanguage}, error=${err.message}`
    );
    throw err;
  }
}

/**
 * Translate a single text block to a target language.
 * @param {string} text - The English source text
 * @param {string} targetLanguage - Language code: 'ru' or 'uz'
 * @returns {Promise<string>} Translated text
 */
async function translateText(text, targetLanguage) {
  if (!text || !text.trim()) return '';
  if (text.length > 4096) {
    throw new Error('Text exceeds 4096 character limit');
  }
  const [translated] = await translateBatch([text], targetLanguage);
  return translated || '';
}

module.exports = {
  translateText,
  translateBatch,
  parseBatchResponse,
  isTranslationAiConfigured,
  AI_NOT_CONFIGURED_MESSAGE,
};
