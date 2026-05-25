/**
 * Generate unique employee birthday wish messages via Groq/Gemini with fallback template.
 */
const { callGroqWithFallback, isAuthOrConfigError } = require('./groqClient');
const { callGeminiJson, GEMINI_API_KEY } = require('./geminiClient');

const SYSTEM_TEXT =
  'You write Telegram birthday messages for a trucking company office team. '
  + 'Return only the message body as Telegram HTML. No markdown fences or JSON. '
  + 'Use only <b> and <i> tags for formatting.';

function formatEmployeeNames(employees) {
  return employees.map((e) => `${e.first_name} ${e.last_name}`.trim()).filter(Boolean);
}

function buildBirthdayPrompt(employees, aiInstructions) {
  const names = formatEmployeeNames(employees);
  return (
    `${aiInstructions}\n\n`
    + 'Write a birthday congratulations message for the following team member(s):\n'
    + `${names.join(', ')}\n\n`
    + 'Rules:\n'
    + '- Include every name listed above.\n'
    + '- Use fresh, unique wording (do not repeat generic boilerplate).\n'
    + '- 3–6 sentences, warm and professional.\n'
    + '- Telegram HTML only: <b> and <i> tags allowed.\n'
    + '- End with a sign-off from Wenze Management.\n'
    + '- Return the message only, no preamble.'
  );
}

function parseBirthdayMessageResponse(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const fence = raw.match(/```(?:html|text)?\s*([\s\S]*?)```/i);
  const candidate = (fence ? fence[1] : raw).trim();
  if (!candidate || candidate.length < 20) return null;
  return candidate.slice(0, 4000);
}

function renderFallbackMessage(employees, fallbackTemplate) {
  const names = formatEmployeeNames(employees).join(', ');
  const template = String(fallbackTemplate || '').includes('{names}')
    ? fallbackTemplate
    : `🎉 <b>Happy Birthday!</b> 🎂\n\nToday we celebrate: <b>{names}</b>!\n\n— <i>Wenze Management</i>`;
  return template.replace(/\{names\}/g, names).slice(0, 4000);
}

async function generateViaGroq(prompt) {
  const { text, model } = await callGroqWithFallback(prompt, {
    systemText: SYSTEM_TEXT,
    temperature: 0.9,
    maxTokens: 800,
    models: [
      process.env.EMPLOYEE_BIRTHDAY_GROQ_MODEL || 'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
    ],
  });
  const message = parseBirthdayMessageResponse(text);
  return { message, provider: 'groq', model };
}

async function generateViaGemini(prompt) {
  const { text, model } = await callGeminiJson({
    systemText: SYSTEM_TEXT,
    userText: prompt,
    maxOutputTokens: 800,
    generationConfig: { temperature: 0.9 },
  });
  const message = parseBirthdayMessageResponse(text);
  return { message, provider: 'gemini', model };
}

async function generateEmployeeBirthdayMessage(employees, aiInstructions, fallbackTemplate) {
  if (!employees || employees.length === 0) {
    throw new Error('No employees provided for birthday message');
  }

  const prompt = buildBirthdayPrompt(employees, aiInstructions);

  try {
    const groq = await generateViaGroq(prompt);
    if (groq.message) return groq;
    if (GEMINI_API_KEY) {
      const gemini = await generateViaGemini(prompt);
      if (gemini.message) return gemini;
    }
  } catch (groqErr) {
    if (GEMINI_API_KEY && !isAuthOrConfigError(groqErr.message)) {
      console.warn('[EMP-BIRTHDAY] Groq failed, trying Gemini:', groqErr.message.slice(0, 200));
      try {
        const gemini = await generateViaGemini(prompt);
        if (gemini.message) return gemini;
      } catch (geminiErr) {
        console.error('[EMP-BIRTHDAY] Gemini failed:', geminiErr.message.slice(0, 200));
      }
    } else {
      console.error('[EMP-BIRTHDAY] Groq failed:', groqErr.message.slice(0, 200));
    }
  }

  return {
    message: renderFallbackMessage(employees, fallbackTemplate),
    provider: 'fallback',
    model: null,
  };
}

module.exports = {
  buildBirthdayPrompt,
  parseBirthdayMessageResponse,
  renderFallbackMessage,
  formatEmployeeNames,
  generateEmployeeBirthdayMessage,
};
