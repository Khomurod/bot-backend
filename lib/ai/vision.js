'use strict';

/**
 * Which models can look at a picture, and whether a request carries one. Pure.
 *
 * UNTIL OCTOBER 2026 EVERY PICTURE WENT TO GEMINI, and only Gemini: the router
 * filtered the roster to the Gemini adapter whenever a request had image parts.
 * The owner's rule (23 October 2026) is free models first, whichever can read a
 * picture, and Claude when they are not sure — so a picture now goes to every
 * provider whose model can see it, in the order the admin set.
 *
 * A MODEL THAT CANNOT SEE MUST NEVER BE ASKED ABOUT A PICTURE. An OpenAI-style
 * text model accepts the text half of the request and answers confidently about
 * a screenshot it never saw — a wrong answer that looks exactly like a right
 * one. So the list below is an allow-list: a model is a vision model only when
 * its family is known to be one. A new vision model nobody listed is simply not
 * asked, which costs a free attempt, never a wrong answer.
 */

/** OpenAI-compatible model families that take image input. */
const OPENAI_CHAT_VISION = [
  /llama-4/i, // Groq / Cerebras / OpenRouter: Llama 4 Scout and Maverick
  /llama-3\.2-(?:11|90)b-vision/i,
  /vision/i,
  /(?:^|[-/_.])vl(?:$|[-/_.:])/i, // qwen2.5-vl, kimi-vl, …
  /pixtral/i,
  /gpt-4o/i,
  /gpt-4\.1/i,
  /gpt-5/i,
  /gemma-3/i,
  /gemini/i, // Gemini served through an OpenAI-compatible router (OpenRouter)
  /claude-(?:3|opus|sonnet|haiku)/i,
  /llava/i,
  /molmo/i,
  /internvl/i,
  /mistral-(?:small|medium)-3/i,
];

/**
 * @param {string} adapter  'gemini' | 'anthropic' | 'openai_chat'
 * @param {string} model
 */
function isVisionModel(adapter, model) {
  const id = String(model || '');
  if (!id) return false;
  if (adapter === 'gemini') return !/embedding|aqa|imagen|tts/i.test(id);
  // Every Claude model since the 3 family reads images.
  if (adapter === 'anthropic') return /claude/i.test(id) && !/claude-(?:1|2|instant)/i.test(id);
  if (adapter === 'openai_chat') return OPENAI_CHAT_VISION.some((re) => re.test(id));
  return false;
}

/** Does this request carry a picture? (Gemini-shaped `inline_data` parts.) */
function hasImageParts(extraParts) {
  return Array.isArray(extraParts)
    && extraParts.some((p) => p && (p.inline_data || p.inlineData));
}

module.exports = { isVisionModel, hasImageParts, OPENAI_CHAT_VISION };
