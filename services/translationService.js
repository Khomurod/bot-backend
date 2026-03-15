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
 * Translate an array of text blocks to a target language.
 * Uses a single API call with numbered items for efficiency.
 * @param {string[]} textsArray - Array of English source texts
 * @param {string} targetLanguage - Language code: 'ru' or 'uz'
 * @returns {Promise<string[]>} Array of translated texts
 */
async function translateBatch(textsArray, targetLanguage) {
  if (!textsArray || textsArray.length === 0) return [];

  // Validate total size
  const totalLength = textsArray.reduce((sum, t) => sum + (t?.length || 0), 0);
  if (totalLength > 4096) {
    throw new Error('Total text exceeds 4096 character limit');
  }

  const langName = LANGUAGE_NAMES[targetLanguage];
  if (!langName) {
    throw new Error(`Unsupported target language: ${targetLanguage}`);
  }

  // For a single item, use simple translation
  if (textsArray.length === 1) {
    const result = await translateText(textsArray[0], targetLanguage);
    return [result];
  }

  console.log(`[Translation] translation_requested: lang=${targetLanguage}, batch_size=${textsArray.length}`);

  try {
    const client = getClient();
    const numberedText = textsArray
      .map((text, i) => `[${i + 1}] ${text}`)
      .join('\n');

    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.3,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Translate each of the following numbered items from English into ${langName}.\nKeep formatting and HTML tags intact.\nReturn each translation on its own line with the same numbering format [1], [2], etc.\nReturn only the translated items, nothing else.\n\n${numberedText}`,
        },
      ],
    });

    const rawResponse = response.choices[0]?.message?.content?.trim();
    if (!rawResponse) {
      throw new Error('Empty response from translation API');
    }

    // Parse numbered responses
    const lines = rawResponse.split('\n').filter(l => l.trim());
    const results = [];

    for (let i = 0; i < textsArray.length; i++) {
      const prefix = `[${i + 1}]`;
      const line = lines.find(l => l.trim().startsWith(prefix));
      if (line) {
        results.push(line.trim().substring(prefix.length).trim());
      } else if (lines[i]) {
        // Fallback: use positional matching, strip any numbering
        results.push(lines[i].replace(/^\[\d+\]\s*/, '').trim());
      } else {
        results.push('');
      }
    }

    console.log(`[Translation] translation_completed: lang=${targetLanguage}, batch_size=${results.length}`);
    return results;
  } catch (err) {
    console.error(`[Translation] translation_failed: lang=${targetLanguage}, error=${err.message}`);
    throw err;
  }
}

module.exports = {
  translateText,
  translateBatch,
};
