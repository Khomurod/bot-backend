const OpenAI = require('openai');
const config = require('../config/config');

let openai = null;

function getClient() {
  if (!openai) {
    if (!config.openaiApiKey) {
      throw new Error('OPENAI_API_KEY is not configured');
    }
    openai = new OpenAI({ apiKey: config.openaiApiKey });
  }
  return openai;
}

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

  const langName = LANGUAGE_NAMES[targetLanguage];
  if (!langName) {
    throw new Error(`Unsupported target language: ${targetLanguage}`);
  }

  console.log(`[Translation] translation_requested: lang=${targetLanguage}, length=${text.length}`);

  try {
    const client = getClient();
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.3,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Translate the following text from English into ${langName}.\nKeep formatting and HTML tags intact.\nReturn only the translated text.\n\nText:\n${text}`,
        },
      ],
    });

    const translated = response.choices[0]?.message?.content?.trim();
    if (!translated) {
      throw new Error('Empty response from translation API');
    }

    console.log(`[Translation] translation_completed: lang=${targetLanguage}, length=${translated.length}`);
    return translated;
  } catch (err) {
    console.error(`[Translation] translation_failed: lang=${targetLanguage}, error=${err.message}`);
    throw err;
  }
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

/**
 * Translate an array of text blocks to a target language in a single API
 * call. Uses JSON response mode so parsing is unambiguous.
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

  if (textsArray.length === 1) {
    const result = await translateText(textsArray[0], targetLanguage);
    return [result];
  }

  console.log(
    `[Translation] translation_requested: lang=${targetLanguage}, batch_size=${textsArray.length}`
  );

  try {
    const client = getClient();
    const userPayload = {
      target_language: langName,
      items: textsArray,
    };

    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content:
            `Translate each string in "items" from English into ${langName}. ` +
            `Preserve HTML tags and links exactly. Return ONLY a JSON object with ` +
            `this exact shape:\n\n` +
            `{ "translations": ["<translation of items[0]>", "<translation of items[1]>", ...] }\n\n` +
            `The translations array MUST have exactly ${textsArray.length} entries in the same order.\n\n` +
            `Input:\n${JSON.stringify(userPayload)}`,
        },
      ],
    });

    const rawResponse = response.choices[0]?.message?.content;
    const results = parseBatchResponse(rawResponse, textsArray.length);

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

module.exports = {
  translateText,
  translateBatch,
  parseBatchResponse,
};
