/**
 * AI-generated Uzbek roast replies for the employee-group "roast" feature.
 * Always witty/intelligent, never rude — this targets a real coworker by
 * name, so tone guardrails live directly in the prompt, not just settings.
 */
const { callGroqWithFallback, isAuthOrConfigError } = require('./groqClient');
const { callGeminiJson, GEMINI_API_KEY } = require('./geminiClient');

const BASE_SYSTEM_TEXT =
  'You write short Telegram replies in Uzbek (Latin script) for a friendly office group chat. '
  + 'You are witty, clever, and sharp — like a stand-up comedian doing a light roast — but never '
  + 'rude, vulgar, or mean-spirited. No profanity, no insults about appearance, family, or anything '
  + 'genuinely hurtful. Keep it playful and smart. Return plain text only, no markdown, no quotes.';

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
    'Vazifa: ularning yozganiga mos, aqlli va o\'tkir hazil-mutoyiba bilan qisqa javob yoz (1-3 gap).',
    'Qoidalar:',
    '- Faqat o\'zbek tilida (lotin yozuvida) yoz.',
    '- Hech qachon qo\'pol, xafa qiluvchi yoki haqoratli so\'z ishlatma.',
    '- Aqlli, ziyoli, biroz kesatiqli bo\'l — do\'stona hazil kabi.',
    '- Ularning xabaridagi mavzuga ishora qil, umumiy gap yozma.',
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

async function generateViaGroq(prompt) {
  const { text, model } = await callGroqWithFallback(prompt, {
    systemText: BASE_SYSTEM_TEXT,
    temperature: 0.9,
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
    generationConfig: { temperature: 0.9 },
  });
  const message = parseRoastResponse(text);
  return { message, provider: 'gemini', model };
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

  try {
    const groq = await generateViaGroq(prompt);
    if (groq.message) return groq;
    if (GEMINI_API_KEY) {
      const gemini = await generateViaGemini(prompt);
      if (gemini.message) return gemini;
    }
  } catch (groqErr) {
    if (GEMINI_API_KEY && !isAuthOrConfigError(groqErr.message)) {
      console.warn('[ROAST] Groq failed, trying Gemini:', groqErr.message.slice(0, 200));
      try {
        const gemini = await generateViaGemini(prompt);
        if (gemini.message) return gemini;
      } catch (geminiErr) {
        console.error('[ROAST] Gemini failed:', geminiErr.message.slice(0, 200));
      }
    } else {
      console.error('[ROAST] Groq failed:', groqErr.message.slice(0, 200));
    }
  }

  return {
    message: pickFallbackLine(),
    provider: 'fallback',
    model: null,
  };
}

function buildManualRoastPrompt({ aiInstructions } = {}) {
  return [
    'Ish guruhida hazil tariqasida Ella (@Ellaaccounting), buxgalteriya bo\'limi xodimiga qaratilgan '
      + 'qisqa, aqlli va o\'tkir hazil-roast xabar yoz (u hech narsa yozmagan, siz o\'zingiz boshlayapsiz).',
    aiInstructions ? `Ohang bo'yicha qo'shimcha ko'rsatma: ${aiInstructions}` : '',
    '',
    'Qoidalar:',
    '- Faqat o\'zbek tilida (lotin yozuvida) yoz.',
    '- Hech qachon qo\'pol, xafa qiluvchi yoki haqoratli so\'z ishlatma — faqat do\'stona hazil.',
    '- Aqlli va ziyoli bo\'l, 1-3 gap.',
    '- Har safar boshqacha, yangi so\'zlar bilan yoz.',
    '- Faqat javob matnini qaytar, boshqa hech narsa yozma.',
  ].filter(Boolean).join('\n');
}

async function generateManualRoastMessage({ aiInstructions } = {}) {
  const prompt = buildManualRoastPrompt({ aiInstructions });

  try {
    const groq = await generateViaGroq(prompt);
    if (groq.message) return groq;
    if (GEMINI_API_KEY) {
      const gemini = await generateViaGemini(prompt);
      if (gemini.message) return gemini;
    }
  } catch (groqErr) {
    if (GEMINI_API_KEY && !isAuthOrConfigError(groqErr.message)) {
      try {
        const gemini = await generateViaGemini(prompt);
        if (gemini.message) return gemini;
      } catch (geminiErr) {
        console.error('[ROAST] Gemini failed (manual):', geminiErr.message.slice(0, 200));
      }
    } else {
      console.error('[ROAST] Groq failed (manual):', groqErr.message.slice(0, 200));
    }
  }

  return {
    message: pickFallbackLine(),
    provider: 'fallback',
    model: null,
  };
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
