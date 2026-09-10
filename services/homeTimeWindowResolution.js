/**
 * Turning a driver's free text into a home-time window, and judging it.
 *
 * Split out of `services/homeTimeRequestService.js` when that file crossed the
 * 500-line limit. The cut is a real boundary rather than a line count: this is
 * the "what did the driver actually say, and may we accept it" half, with no
 * Telegram, no cards and no clarification state. The orchestration that acts on
 * the answer stays where it was, and both functions are re-exported from there
 * so no importer moves.
 */
const {
  buildHomeTimeDateReplyPrompt,
  parseHomeTimeWindowText,
  isReasonableHomeWindow,
} = require('./homeTimeRequestConstants');
const { callGeminiJson } = require('./geminiClient');
const { classifyWindowAgainstPolicy } = require('./homeTimeDateResolver');
const { todayIsoChicago } = require('./homeTimeClarificationFlow');

/**
 * Which dates of a resolved window, if any, have to be asked about again.
 *
 * ONLY `too_far_ahead`, and the exclusion is the interesting part.
 *
 * An over-allowance window is NOT refused here, deliberately. The subsystem
 * already has a designed answer for it — `sendPolicyResponse` records the
 * request and replies with a firm reminder of the four-week rule, and withholds
 * the 👍 — and that is the right one: the driver asked for something real, and
 * the company's answer is "here is the policy", not silence and the same
 * question again. Refusing to store it would replace a clear answer with a loop.
 *
 * A start date beyond the horizon is a different animal. `2027-01-02` on
 * request 139 is not a driver asking for January; it is a mis-parsed year that
 * `isReasonableWindow` waved through because a year is inside its horizon. There
 * is nothing to record and nothing to answer — only a date to ask about again.
 *
 * A PARTIAL window is judged too. Requiring `complete` here let "home
 * 2027-01-02" with no return date through, and `createClarification` wrote the
 * mis-parsed year down before politely asking for the other half.
 *
 * @returns {string[]} the fields to clear — empty when nothing is disputed
 */
function windowFieldsToReask(window, settings) {
  if (!window) return [];
  const verdict = classifyWindowAgainstPolicy(window.homeStartDate, window.returnToRoadDate, {
    referenceIso: todayIsoChicago(),
    homeAllowanceDays: settings?.home_allowance_days,
  });
  return verdict.reason === 'too_far_ahead' ? verdict.disputedFields : [];
}

/**
 * Resolve a home-time window from a driver's free-text reply. AI first, then the
 * deterministic parser. Returns `{ homeFrom, homeTo }` strings or null. Kept for
 * back-compat (the conversational pipeline uses classifyHomeTimeMessage).
 */
async function parseHomeTimeDates({ text, todayIso }) {
  const today = todayIso || todayIsoChicago();
  const prompt = buildHomeTimeDateReplyPrompt({ text, todayLabel: today });
  try {
    const { parsed } = await callGeminiJson({
      capability: 'home_time_dates',
      userText: prompt,
      maxOutputTokens: 120,
      validateParsed: (p) => typeof p?.found === 'boolean',
    });
    if (parsed.found && parsed.home_from && parsed.home_to
      && isReasonableHomeWindow(parsed.home_from, parsed.home_to, today)) {
      return { homeFrom: String(parsed.home_from), homeTo: String(parsed.home_to) };
    }
  } catch (err) {
    console.warn('[HOME-TIME-REQ] date-reply AI parse failed, using deterministic parser:', err.message);
  }
  const window = parseHomeTimeWindowText(text, today);
  if (window && isReasonableHomeWindow(window.homeFrom, window.homeTo, today)) {
    return { homeFrom: window.homeFrom, homeTo: window.homeTo };
  }
  return null;
}

module.exports = { windowFieldsToReask, parseHomeTimeDates };
