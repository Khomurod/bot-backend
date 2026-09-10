/**
 * AI-generated playful roasts when @datatruck_driver_bot fails a command.
 */
const { callGroqWithFallback } = require('./groqClient');

const SYSTEM_TEXT =
  'You write short, playful Telegram replies roasting a clumsy trucking dispatch bot. '
  + 'The joke is always aimed at the bot, never at human drivers or dispatchers. '
  + 'Return plain text only — no markdown, no JSON, no quotes around the message.';

const FALLBACK_LINES = [
  'You gotta get smart, bot — that command was not it.',
  'Still can\'t do this? Come on, level up.',
  'Nice try, Datatruck — maybe read the manual first.',
  'That command went nowhere. Again.',
  'Bro bot, we talked about this — valid commands only.',
  'One day you\'ll learn routes AND slash commands. Not today?',
  'Error vibes only. Fix your homework.',
  'You had one job: understand the command. Wild miss.',
  'Dispatch bot school called — they want you back in class.',
  'If confusion was freight, you\'d be fully loaded.',
  'That was not a valid move, captain bot.',
  'Try harder — the drivers are watching.',
  'Command rejected. Shocking, absolutely shocking.',
  'Your GPS works but your parser doesn\'t, huh?',
  'We believe in you. Your command handler does not.',
  'Another day, another unknown command from our favorite bot.',
  'Slow down and think — humans do it all the time.',
  'That request died faster than a missed pickup window.',
  'Bot, you\'re better than this. Probably.',
  'Upgrade loading… still loading… command still wrong.',
];

function buildBanterPrompt(failureSnippet) {
  const snippet = String(failureSnippet || '').trim().slice(0, 500);
  return (
    'The Datatruck driver bot just failed and posted this to a driver Telegram group:\n'
    + `"${snippet}"\n\n`
    + 'Write ONE playful roast reply (1-2 sentences max) teasing the bot for failing.\n'
    + 'Rules:\n'
    + '- Be funny and light, never mean to people.\n'
    + '- Do not mention Wenze or @wenzefeedback_bot.\n'
    + '- Use fresh, unique wording every time.\n'
    + '- Plain text only, under 240 characters.\n'
    + '- Return the message only.'
  );
}

function parseBanterResponse(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const fence = raw.match(/```(?:text|plain)?\s*([\s\S]*?)```/i);
  let candidate = (fence ? fence[1] : raw).trim();
  candidate = candidate.replace(/^["']|["']$/g, '').trim();
  if (!candidate || candidate.length < 8) return null;
  return candidate.slice(0, 280);
}

function pickFallbackLine(excludeTexts = []) {
  const exclude = new Set(excludeTexts.map((t) => String(t || '').trim().toLowerCase()).filter(Boolean));
  const available = FALLBACK_LINES.filter((line) => !exclude.has(line.toLowerCase()));
  const pool = available.length ? available : FALLBACK_LINES;
  return pool[Math.floor(Math.random() * pool.length)];
}

async function generateViaGroq(prompt) {
  const { text, model } = await callGroqWithFallback(prompt, {
    systemText: SYSTEM_TEXT,
    temperature: 0.95,
    maxTokens: 120,
    models: [
      process.env.DATATRUCK_BANTER_GROQ_MODEL || 'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
    ],
  });
  const message = parseBanterResponse(text);
  return { message, provider: 'router', model };
}

async function generateDatatruckBanterMessage({ failureSnippet, excludeTexts = [] } = {}) {
  const prompt = buildBanterPrompt(failureSnippet);

  // ONE call. This was "try Groq, then Gemini" — hand-coded cross-provider
  // fallback gated on a Gemini key being present in the ENVIRONMENT, which since
  // Stage 5 is no longer where a key has to live. The router owns the fallback
  // now, over the roster an administrator configured, and its `isAuthOrConfigError`
  // abort is gone with it: a dead key moves to the next provider instead of
  // ending the chain.
  try {
    const generated = await generateViaGroq(prompt);
    if (generated.message) return generated;
  } catch (err) {
    console.error('[DATATRUCK-BANTER] AI unavailable:', String(err.message || err).slice(0, 200));
  }

  return {
    message: pickFallbackLine(excludeTexts),
    provider: 'fallback',
    model: null,
  };
}

module.exports = {
  SYSTEM_TEXT,
  FALLBACK_LINES,
  buildBanterPrompt,
  parseBanterResponse,
  pickFallbackLine,
  generateDatatruckBanterMessage,
};
