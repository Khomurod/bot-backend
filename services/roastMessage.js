/**
 * AI-generated Uzbek roast replies for the employee-group "roast" feature.
 * Always witty/intelligent, never rude — this targets a real coworker by
 * name, so tone guardrails live directly in the prompt, not just settings.
 *
 * OpenAI (gpt-4o-mini) is tried first: it is the model already proven for
 * clean Uzbek output in translationService.js, whereas Groq's Llama models
 * regularly mix register (sen/siz) and produce awkward, ungrammatical
 * Uzbek. Groq/Gemini remain as fallbacks for when OpenAI is unavailable.
 */
const OpenAI = require('openai');
const config = require('../config/config');
const { callGroqWithFallback, isAuthOrConfigError } = require('./groqClient');
const { callGeminiJson, GEMINI_API_KEY } = require('./geminiClient');

let openaiClient = null;
function getOpenAiClient() {
  if (!config.openaiApiKey) return null;
  if (!openaiClient) openaiClient = new OpenAI({ apiKey: config.openaiApiKey });
  return openaiClient;
}

const BASE_SYSTEM_TEXT =
  'You write short Telegram replies in Uzbek (Latin script) for a friendly office group chat. '
  + 'You are witty, clever, and sharp — like a stand-up comedian doing a light roast — but never '
  + 'rude, vulgar, or mean-spirited. No profanity, no insults about appearance, family, or anything '
  + 'genuinely hurtful. Keep it playful and smart.\n\n'
  + 'Uzbek quality is critical:\n'
  + '- Write natural, fluent, fully grammatically correct Uzbek. No made-up words, no awkward '
  + 'calques from English, no typos.\n'
  + '- Pick ONE register — either informal ("sen") or polite ("siz") — and use it consistently '
  + 'in every sentence. Never mix "sen" and "siz" forms in the same reply.\n'
  + '- Keep verb tense and person consistent throughout the reply.\n'
  + '- Before answering, silently re-read your draft and fix any grammar mistake — only the '
  + 'final, corrected reply should be returned.\n\n'
  + 'Return plain text only, no markdown, no quotes.';

const FALLBACK_LINES_UZBEK = [
  'Menga bugun ham savol berishga jur\'at etding — hurmatga loyiq jasorat! 😄',
  'Bu gapni AI ham, oddiy odam ham tushunmaydi, lekin baribir javob beraman.',
  'Sen meni chaqirding, men esa hozir eng aqlli javobni tayyorlayapman... deyarli.',
  'Xo\'p, ko\'raylik-chi, bu safar qanday bahona topding ekan.',
  'Rostini aytsam, buni kutmagandim — lekin ajablanarli emas.',
];

function buildRoastPrompt({
  triggerText,
  isTarget,
  displayName,
  aiInstructions,
} = {}) {
  const who = isTarget
    ? `Ella (@Ellaaccounting), buxgalteriya bo'limidan`
    : (displayName ? `${displayName} ismli hamkasb` : 'bir hamkasb');

  return [
    `Ish guruhida ${who} sizga (botga) javob yozdi yoki sizni belgiladi (mention qildi).`,
    aiInstructions ? `Ohang bo'yicha qo'shimcha ko'rsatma: ${aiInstructions}` : '',
    '',
    'Ularning xabari (nima haqida yozganini o\'qib, o\'shanga mos javob ber):',
    `"""\n${String(triggerText || '(matn yo\'q, faqat mention/reply)').slice(0, 800)}\n"""`,
    '',
    'Vazifa: ularning yozganiga aniq mos, aqlli va o\'tkir hazil-mutoyiba bilan qisqa javob yoz (1-3 gap).',
    'Qoidalar:',
    '- Faqat o\'zbek tilida (lotin yozuvida), xatosiz va tabiiy yoz.',
    '- Butun javob davomida faqat bitta shaklda gapir — yoki "sen", yoki "siz"; ikkalasini aralashtirma.',
    '- Hech qachon qo\'pol, xafa qiluvchi yoki haqoratli so\'z ishlatma.',
    '- Aqlli, ziyoli, biroz kesatiqli bo\'l — do\'stona hazil kabi.',
    '- Ularning xabaridagi mavzuga aniq ishora qil, umumiy yoki mavzudan uzoq gap yozma.',
    '- Javobni yozib bo\'lgach, uni o\'zing qayta o\'qib, grammatik xatolarni tuzat, faqat shundan keyingi yakuniy matnni qaytar.',
    '- Faqat javob matnini qaytar, boshqa hech narsa yozma.',
  ].filter(Boolean).join('\n');
}

function parseRoastResponse(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const fence = raw.match(/```(?:text|plain)?\s*([\s\S]*?)```/i);
  let candidate = (fence ? fence[1] : raw).trim();
  candidate = candidate.replace(/^["']|["']$/g, '').trim();
  if (!candidate || candidate.length < 4) return null;
  return candidate.slice(0, 500);
}

function pickFallbackLine() {
  return FALLBACK_LINES_UZBEK[Math.floor(Math.random() * FALLBACK_LINES_UZBEK.length)];
}

async function generateViaOpenAi(prompt) {
  const client = getOpenAiClient();
  if (!client) return { message: null, provider: 'openai', model: null };

  const model = process.env.ROAST_OPENAI_MODEL || 'gpt-4o-mini';
  const response = await client.chat.completions.create({
    model,
    temperature: 0.6,
    messages: [
      { role: 'system', content: BASE_SYSTEM_TEXT },
      { role: 'user', content: prompt },
    ],
  });
  const message = parseRoastResponse(response.choices[0]?.message?.content);
  return { message, provider: 'openai', model };
}

async function generateViaGroq(prompt) {
  const { text, model } = await callGroqWithFallback(prompt, {
    systemText: BASE_SYSTEM_TEXT,
    temperature: 0.6,
    maxTokens: 200,
    models: [
      process.env.ROAST_GROQ_MODEL || 'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
    ],
  });
  const message = parseRoastResponse(text);
  return { message, provider: 'groq', model };
}

async function generateViaGemini(prompt) {
  const { text, model } = await callGeminiJson({
    systemText: BASE_SYSTEM_TEXT,
    userText: prompt,
    maxOutputTokens: 200,
    generationConfig: { temperature: 0.6 },
  });
  const message = parseRoastResponse(text);
  return { message, provider: 'gemini', model };
}

/**
 * Try OpenAI, then Groq, then Gemini, then a static fallback line. Each
 * provider's failure is logged and swallowed so one bad API never blocks a
 * reply — the feature always answers with *something* in the group.
 */
async function generateWithProviderChain(prompt, label) {
  try {
    const openaiResult = await generateViaOpenAi(prompt);
    if (openaiResult.message) return openaiResult;
  } catch (err) {
    console.error(`[ROAST] OpenAI failed (${label}):`, err.message.slice(0, 200));
  }

  try {
    const groq = await generateViaGroq(prompt);
    if (groq.message) return groq;
  } catch (err) {
    console.error(`[ROAST] Groq failed (${label}):`, err.message.slice(0, 200));
    if (isAuthOrConfigError(err.message) && !GEMINI_API_KEY) {
      return { message: pickFallbackLine(), provider: 'fallback', model: null };
    }
  }

  if (GEMINI_API_KEY) {
    try {
      const gemini = await generateViaGemini(prompt);
      if (gemini.message) return gemini;
    } catch (err) {
      console.error(`[ROAST] Gemini failed (${label}):`, err.message.slice(0, 200));
    }
  }

  return { message: pickFallbackLine(), provider: 'fallback', model: null };
}

async function generateRoastMessage({
  triggerText,
  isTarget,
  displayName,
  aiInstructions,
} = {}) {
  const prompt = buildRoastPrompt({
    triggerText, isTarget, displayName, aiInstructions,
  });
  return generateWithProviderChain(prompt, 'reactive');
}

function buildManualRoastPrompt({ aiInstructions } = {}) {
  return [
    'Ish guruhida hazil tariqasida Ella (@Ellaaccounting), buxgalteriya bo\'limi xodimiga qaratilgan '
      + 'qisqa, aqlli va o\'tkir hazil-roast xabar yoz (u hech narsa yozmagan, siz o\'zingiz boshlayapsiz).',
    aiInstructions ? `Ohang bo'yicha qo'shimcha ko'rsatma: ${aiInstructions}` : '',
    '',
    'Qoidalar:',
    '- Faqat o\'zbek tilida (lotin yozuvida), xatosiz va tabiiy yoz.',
    '- Butun javob davomida faqat bitta shaklda gapir — yoki "sen", yoki "siz"; ikkalasini aralashtirma.',
    '- Hech qachon qo\'pol, xafa qiluvchi yoki haqoratli so\'z ishlatma — faqat do\'stona hazil.',
    '- Aqlli va ziyoli bo\'l, 1-3 gap.',
    '- Har safar boshqacha, yangi so\'zlar bilan yoz.',
    '- Javobni yozib bo\'lgach, uni o\'zing qayta o\'qib, grammatik xatolarni tuzat, faqat shundan keyingi yakuniy matnni qaytar.',
    '- Faqat javob matnini qaytar, boshqa hech narsa yozma.',
  ].filter(Boolean).join('\n');
}

async function generateManualRoastMessage({ aiInstructions } = {}) {
  const prompt = buildManualRoastPrompt({ aiInstructions });
  return generateWithProviderChain(prompt, 'manual');
}

module.exports = {
  BASE_SYSTEM_TEXT,
  FALLBACK_LINES_UZBEK,
  buildRoastPrompt,
  parseRoastResponse,
  pickFallbackLine,
  generateRoastMessage,
  buildManualRoastPrompt,
  generateManualRoastMessage,
};
