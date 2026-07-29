/**
 * Home-Time conversational message composer.
 *
 * All the AI-written prose the Home-Time workflow sends: the questions asking a
 * driver for missing dates, the policy acknowledgment / warning, and the note on
 * the approval card. Extracted from homeTimeRequestService so that file stays
 * within the per-file line limit and so the wording can be tested without the
 * orchestrator's database and Telegram dependencies.
 *
 * Every generator has a deterministic fallback: when Gemini is unavailable the
 * exact policy meaning is preserved, never dropped.
 *
 * This module composes TEXT ONLY. Whether that text may actually be sent to a
 * driver group is decided by services/homeTimeDriverChannel.
 */
const { callGeminiText } = require('./geminiClient');
const { weeksFromDays, homeTimePolicyApplies } = require('./homeTimeRequestConstants');

function languageLine(language) {
  return language && !['en', 'english'].includes(String(language).toLowerCase())
    ? `Write in the driver's language (${language}); keep it natural and simple.`
    : "Match the driver's language when obvious; otherwise use English.";
}

function conversationalPrompt(kind, language, facts = {}) {
  const intro = 'You are a friendly but firm dispatch assistant for a US trucking company. '
    + 'Write ONE short message (1-2 sentences, plain text, no markdown). You may address the driver warmly (e.g. "brother").';
  const asks = {
    ask_return_to_road: 'Ask the driver what date they plan to get back on the road after their home time.',
    ask_home_start: 'Ask the driver what date they plan to arrive home.',
    ask_both: 'Ask the driver which dates they want for home time: the day they will arrive home and the day they will be back on the road.',
    ask_unplanned_return: 'Warmly welcome the driver home, then ask what date they plan to get back on the road after their home time.',
    reminder_return: 'Politely but firmly remind the driver that we still need the date they will be back on the road after home time; say it is important for us to know.',
    reminder_home_start: 'Politely but firmly remind the driver that we still need the date they plan to arrive home; say it is important for us to know.',
    reminder_both: 'Politely but firmly remind the driver that we still need their home-time dates (arrive home and back on the road); say it is important for us to know.',
    policy_ack: 'Acknowledge that you noted their home-time dates and thank them. Do NOT say the request is approved.',
    policy_warning: `Firmly but kindly remind the driver of the agreement: at least ${facts.allowanceWeeks || 4} weeks on the road and up to ${facts.homeAllowanceDays || 4} days at home. One or two sentences, no long explanation, no aggressive wording. Do NOT say the request is approved or denied.`,
  };
  return `${intro} ${asks[kind] || asks.ask_both} ${languageLine(language)}`;
}

/** AI-written conversational line with a deterministic fallback. Never throws. */
async function generateMessage({ kind, language, facts, fallback }) {
  try {
    const { text } = await callGeminiText({
      userText: conversationalPrompt(kind, language, facts),
      maxOutputTokens: 120,
    });
    const clean = String(text || '').trim();
    if (clean) return clean;
  } catch (err) {
    console.warn(`[HOME-TIME-REQ] AI message (${kind}) failed, using fallback:`, err.message);
  }
  return fallback;
}

/**
 * AI-written note for the approval card. The deterministic fallback keeps the
 * exact policy meaning when the AI is unavailable.
 */
async function generateRequestText({
  policyMet, daysOnRoad, allowanceWeeks, homeAllowanceDays, driverName, driverType,
}) {
  const weeks = daysOnRoad == null ? null : weeksFromDays(daysOnRoad);
  const policyApplies = homeTimePolicyApplies(driverType);

  let situation;
  if (!policyApplies) {
    situation = 'The driver is an owner operator, so the company 4-week home-time policy and extra-week bonus do not apply. '
      + 'Say you logged the request for tracking, and that a human still needs to approve the dates.';
  } else if (policyMet === true) {
    situation = `The driver HAS been on the road about ${weeks} weeks (${daysOnRoad} days), which is at least `
      + `the required ${allowanceWeeks} weeks. Say you believe they are good to take ${homeAllowanceDays} days home, `
      + 'but you are only a bot so a human must confirm.';
  } else if (policyMet === false) {
    situation = `The driver has only been on the road about ${weeks} weeks (${daysOnRoad} days), which is LESS than `
      + `the agreed ${allowanceWeeks} weeks. Politely note that per the agreement they should be on the road at least `
      + `${allowanceWeeks} weeks, that you cannot decide on a human's behalf, and that the humans should decide.`;
  } else {
    situation = 'You could not confirm how long the driver has been on the road, so you cannot judge the '
      + `${allowanceWeeks}-week policy. Ask the humans to decide.`;
  }

  const prompt = 'You are a friendly dispatch assistant bot for a trucking company. Write ONE short, warm message '
    + `(2-3 sentences, plain text, no markdown) responding to a home-time request. ${situation} `
    + 'Make clear you are a bot and a human must approve.';

  try {
    const { text } = await callGeminiText({ userText: prompt, maxOutputTokens: 250 });
    const clean = String(text || '').trim();
    if (clean) return clean;
  } catch (err) {
    console.warn('[HOME-TIME-REQ] AI text generation failed, using fallback:', err.message);
  }

  if (!policyApplies) {
    return 'I logged this owner operator home-time request for tracking. The company 4-week rule does not apply here, '
      + "but I'm still a bot, so a human needs to approve the dates.";
  }
  if (policyMet === true) {
    return `I see it's been about ${weeks} weeks (${daysOnRoad} days) since you started driving, so I believe `
      + `you're good to have home time for ${homeAllowanceDays} days. But I'm still a bot, so I need a human's permission.`;
  }
  if (policyMet === false) {
    return `I see it hasn't been ${allowanceWeeks} weeks since you started driving - only about ${weeks} weeks `
      + `(${daysOnRoad} days). Per our agreement you should be on the road for at least ${allowanceWeeks} weeks. `
      + "I'm just a bot and can't decide on a human's behalf, so let the humans decide.";
  }
  return `I couldn't confirm how long you've been on the road, so I can't check the ${allowanceWeeks}-week policy. `
    + "I'm just a bot, so let the humans decide.";
}

module.exports = {
  conversationalPrompt,
  generateMessage,
  generateRequestText,
};
