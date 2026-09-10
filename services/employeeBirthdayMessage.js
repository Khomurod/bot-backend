/**
 * Generate unique employee birthday wish messages via Groq/Gemini with fallback template.
 */
const { callGroqWithFallback } = require('./groqClient');

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
    // Same reason as the banter path: a 200 with an empty or under-length body
    // is a success to the router and a failure to this feature, and only a
    // validator tells it the difference. The parser IS the validator, so the
    // floor the router enforces is the floor the message has to clear.
    validateResult: (raw) => (parseBirthdayMessageResponse(raw)
      ? true
      : { message: 'the response was empty or too short to be a birthday message' }),
  });
  const message = parseBirthdayMessageResponse(text);
  return { message, provider: 'router', model };
}

async function generateEmployeeBirthdayMessage(employees, aiInstructions, fallbackTemplate) {
  if (!employees || employees.length === 0) {
    throw new Error('No employees provided for birthday message');
  }

  const prompt = buildBirthdayPrompt(employees, aiInstructions);

  // ONE call. This was "try Groq, then Gemini" — hand-coded cross-provider
  // fallback gated on a Gemini key being present in the ENVIRONMENT, which since
  // Stage 5 is no longer where a key has to live. The router owns the fallback,
  // over the roster an administrator configured.
  try {
    const generated = await generateViaGroq(prompt);
    if (generated.message) return generated;
  } catch (err) {
    console.error('[EMP-BIRTHDAY] AI unavailable:', String(err.message || err).slice(0, 200));
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
