/**
 * Home-Time Request service.
 *
 * Triggered from the bot's group-message handler when a company rep tags an
 * approver (@tomr_robins0n / @SaffieBNett) in a DRIVER group. We:
 *   1. Look at the last ~30 minutes of that group's chat (in-memory buffer).
 *   2. Ask the AI whether this is actually a home-time request (reps get tagged
 *      for many reasons).
 *   3. If it is, work out how long the driver has been on the road (from the
 *      home-time tracker), write an AI note about the policy, and post it with
 *      "Approve" / "Do Not Approve" buttons that only the approvers can use.
 *   4. Record the request so the admin panel can flag policy violators later.
 *
 * The `telegram` instance is always passed in (never required) so this module
 * stays free of a require cycle with bot.js - same approach as homeTimeService.
 */
const { DateTime } = require('luxon');
const { Markup } = require('telegraf');
const db = require('../database/db');
const ht = require('../database/homeTime');
const config = require('../config/config');
const { safeSend } = require('./telegramHtml');
const recentBuffer = require('./recentMessageBuffer');
const { callGeminiJson, callGeminiText } = require('./geminiClient');
const {
  HOME_TIME_APPROVER_MENTIONS,
  weeksFromDays,
  isPolicyMet,
  computeHomeWindow,
  homeTimePolicyApplies,
  hasHomeTimeSignal,
  buildHomeTimeClassificationPrompt,
} = require('./homeTimeRequestConstants');
const { wholeDaysBetween } = require('./homeTimeConstants');
const { inferDriverType } = require('./driverProfileParse');

const CALLBACK_PREFIX = 'htreq';

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function approverTagLine() {
  return HOME_TIME_APPROVER_MENTIONS.join(' / ');
}

async function resolveDriverLabel(group) {
  try {
    const profile = await db.getDriverProfileByGroupId(group.id);
    const name = [profile?.first_name, profile?.last_name].filter(Boolean).join(' ').trim();
    return {
      driverName: name || group.group_name || `Group ${group.id}`,
      unitNumber: profile?.unit_number || null,
      driverType: profile?.driver_type || inferDriverType(group.group_name || ''),
    };
  } catch (_) {
    return {
      driverName: group.group_name || `Group ${group.id}`,
      unitNumber: null,
      driverType: inferDriverType(group.group_name || ''),
    };
  }
}

/**
 * Ask the AI whether the recent conversation is a home-time request.
 *
 * Inputs:
 *   - `transcript`  : the last ~30 minutes of the group's chat (for context).
 *   - `triggerText` : the message that just tagged an approver (carries intent).
 *
 * Accuracy guards (an approver tag is usually NOT a home-time request — reps get
 * tagged for oil changes, load problems, breakdowns, etc.):
 *   - The AI returns a confidence. A low-confidence "yes" with no home-time
 *     wording anywhere in the window is treated as "not a request".
 *   - If the AI is unavailable we no longer blanket-default to "yes"; we fall
 *     back to deterministic home-time language detection, which only surfaces a
 *     card when the text actually mentions going home / time off.
 *
 * Accepts either an options object `{ transcript, triggerText }` or, for
 * backward compatibility, a bare transcript string.
 */
async function classifyHomeTimeRequest(input) {
  const { transcript, triggerText } = typeof input === 'string'
    ? { transcript: input, triggerText: '' }
    : (input || {});
  const haystack = `${triggerText || ''}\n${transcript || ''}`;
  const keywordSignal = hasHomeTimeSignal(haystack);

  const prompt = buildHomeTimeClassificationPrompt({
    transcript,
    triggerText,
    approvers: HOME_TIME_APPROVER_MENTIONS,
  });
  try {
    const { parsed } = await callGeminiJson({
      userText: prompt,
      maxOutputTokens: 200,
      validateParsed: (p) => typeof p?.is_home_time_request === 'boolean',
    });
    const confidence = String(parsed.confidence || '').toLowerCase();
    let isRequest = Boolean(parsed.is_home_time_request);
    let reason = String(parsed.reason || '').slice(0, 300);

    // A low-confidence "yes" with no explicit home-time wording is most likely a
    // misread of an ordinary tag — do not post a card for it.
    if (isRequest && confidence === 'low' && !keywordSignal) {
      isRequest = false;
      reason = `Low-confidence AI guess with no home-time wording — skipped. ${reason}`.trim();
    }
    return { isRequest, reason, confidence: confidence || null, aiUsed: true };
  } catch (err) {
    console.warn('[HOME-TIME-REQ] AI classification failed, using keyword heuristic:', err.message);
    return {
      isRequest: keywordSignal,
      reason: keywordSignal
        ? 'AI unavailable — home-time wording detected, surfaced for human review.'
        : 'AI unavailable — no home-time wording detected, not surfaced.',
      confidence: null,
      aiUsed: false,
    };
  }
}

/**
 * AI-written note for the card. Deterministic fallback keeps the exact policy
 * meaning when the AI is unavailable.
 */
async function generateRequestText({
  policyMet, daysOnRoad, allowanceWeeks, homeAllowanceDays, driverName, driverType,
}) {
  const weeks = daysOnRoad == null ? null : weeksFromDays(daysOnRoad);
  const policyApplies = homeTimePolicyApplies(driverType);

  let situation;
  if (!policyApplies) {
    situation = `The driver is an owner operator, so the company 4-week home-time policy and extra-week bonus do not apply. `
      + `Say you logged the request for tracking, and that a human still needs to approve the dates.`;
  } else if (policyMet === true) {
    situation = `The driver HAS been on the road about ${weeks} weeks (${daysOnRoad} days), which is at least `
      + `the required ${allowanceWeeks} weeks. Say you believe they are good to take ${homeAllowanceDays} days home, `
      + `but you are only a bot so a human must confirm.`;
  } else if (policyMet === false) {
    situation = `The driver has only been on the road about ${weeks} weeks (${daysOnRoad} days), which is LESS than `
      + `the agreed ${allowanceWeeks} weeks. Politely note that per the agreement they should be on the road at least `
      + `${allowanceWeeks} weeks, that you cannot decide on a human's behalf, and that the humans should decide.`;
  } else {
    situation = `You could not confirm how long the driver has been on the road, so you cannot judge the `
      + `${allowanceWeeks}-week policy. Ask the humans to decide.`;
  }

  const prompt = `You are a friendly dispatch assistant bot for a trucking company. Write ONE short, warm message `
    + `(2-3 sentences, plain text, no markdown) responding to a home-time request. ${situation} `
    + `Make clear you are a bot and a human must approve.`;

  try {
    const { text } = await callGeminiText({ userText: prompt, maxOutputTokens: 250 });
    const clean = String(text || '').trim();
    if (clean) return clean;
  } catch (err) {
    console.warn('[HOME-TIME-REQ] AI text generation failed, using fallback:', err.message);
  }

  if (!policyApplies) {
    return `I logged this owner operator home-time request for tracking. The company 4-week rule does not apply here, `
      + `but I'm still a bot, so a human needs to approve the dates.`;
  }
  if (policyMet === true) {
    return `I see it's been about ${weeks} weeks (${daysOnRoad} days) since you started driving, so I believe `
      + `you're good to have home time for ${homeAllowanceDays} days. But I'm still a bot, so I need a human's permission.`;
  }
  if (policyMet === false) {
    return `I see it hasn't been ${allowanceWeeks} weeks since you started driving - only about ${weeks} weeks `
      + `(${daysOnRoad} days). Per our agreement you should be on the road for at least ${allowanceWeeks} weeks. `
      + `I'm just a bot and can't decide on a human's behalf, so let the humans decide.`;
  }
  return `I couldn't confirm how long you've been on the road, so I can't check the ${allowanceWeeks}-week policy. `
    + `I'm just a bot, so let the humans decide.`;
}

function buildCardText({
  driverName, unitNumber, driverType, text, daysOnRoad, policyMet, homeFrom, homeTo,
}) {
  const who = `${escapeHtml(driverName)}${unitNumber ? ` (Unit ${escapeHtml(unitNumber)})` : ''}`;
  const policyApplies = homeTimePolicyApplies(driverType);
  const flag = policyMet === false ? '⚠️ ' : '';
  const lines = [
    `🏠 <b>Home-Time Request — ${who}</b>`,
    '',
    `${flag}${escapeHtml(text)}`,
    '',
    `Driver type: <b>${policyApplies ? 'Company driver' : 'Owner operator'}</b>`,
    `Proposed home time: <b>${escapeHtml(homeFrom)} → ${escapeHtml(homeTo)}</b>`,
  ];
  if (daysOnRoad != null) {
    lines.push(`On the road: <b>${daysOnRoad} days</b> (~${weeksFromDays(daysOnRoad)} weeks)`);
  }
  if (!policyApplies) {
    lines.push('Policy: <b>N/A</b> (owner operator)');
  }
  lines.push('', `Only ${approverTagLine()} can decide.`);
  return lines.join('\n');
}

function buildDecisionButtons(requestId) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Approve', `${CALLBACK_PREFIX}:approve:${requestId}`),
      Markup.button.callback('❌ Do Not Approve', `${CALLBACK_PREFIX}:deny:${requestId}`),
    ],
  ]);
}

/**
 * Entry point from the bot. Safe to call on any approver-tag message in a driver
 * group. Never throws.
 */
async function handleApproverMention(telegram, group, message) {
  try {
    if (!group || group.group_type !== 'driver') return;

    const existing = await ht.getPendingHomeTimeRequestForGroup(group.id);
    if (existing) return;

    // The triggering message is passed explicitly (in addition to the rolling
    // buffer) so the AI always sees the actual tag text, even right after a
    // restart when the buffer has not warmed up yet.
    const triggerText = message?.text || message?.caption || '';
    const transcript = recentBuffer.renderTranscript(group.telegram_group_id);
    const verdict = await classifyHomeTimeRequest({ transcript, triggerText });
    if (!verdict.isRequest) return;

    const settings = await ht.getHomeTimeSettings();
    const allowanceWeeks = settings?.road_allowance_weeks || 4;
    const homeAllowanceDays = settings?.home_allowance_days || 4;

    const homeStatus = await ht.getDriverHomeStatus(group.id);
    const nowIso = DateTime.now().toUTC().toISO();
    let roadStartedAt = null;
    let daysOnRoad = null;
    if (homeStatus && homeStatus.state === 'road') {
      roadStartedAt = homeStatus.state_since;
      daysOnRoad = wholeDaysBetween(homeStatus.state_since, nowIso);
    }

    const { driverName, unitNumber, driverType } = await resolveDriverLabel(group);
    const policyMet = isPolicyMet(daysOnRoad, allowanceWeeks, driverType);
    const { homeFrom, homeTo } = computeHomeWindow(nowIso, homeAllowanceDays);

    const text = await generateRequestText({
      policyMet,
      daysOnRoad,
      allowanceWeeks,
      homeAllowanceDays,
      driverName,
      driverType,
    });

    const fromUser = message?.from || {};
    const request = await ht.insertHomeTimeRequest({
      groupId: group.id,
      telegramGroupId: group.telegram_group_id,
      driverName,
      unitNumber,
      requestedByUserId: fromUser.id || null,
      requestedByUsername: fromUser.username || null,
      roadStartedAt,
      daysOnRoad,
      policyMet,
      homeFrom,
      homeTo,
      status: 'pending',
      source: 'telegram',
      aiReasoning: verdict.confidence
        ? `[confidence: ${verdict.confidence}] ${verdict.reason || ''}`.trim()
        : (verdict.reason || null),
    });

    const cardText = buildCardText({
      driverName,
      unitNumber,
      driverType,
      text,
      daysOnRoad,
      policyMet,
      homeFrom,
      homeTo,
    });
    const sent = await safeSend(() => telegram.sendMessage(group.telegram_group_id, cardText, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...buildDecisionButtons(request.id),
    }));
    await ht.setHomeTimeRequestMessage(request.id, group.telegram_group_id, sent?.message_id || null);

    console.log(`[HOME-TIME-REQ] Request #${request.id} posted for ${driverName} (${driverType}, policyMet=${policyMet}).`);
  } catch (err) {
    console.error('[HOME-TIME-REQ] handleApproverMention error:', err.message);
  }
}

function buildDecidedCardText(request, decision, decidedByUsername) {
  const who = `${escapeHtml(request.driver_name || 'Driver')}`
    + `${request.unit_number ? ` (Unit ${escapeHtml(request.unit_number)})` : ''}`;
  const by = decidedByUsername ? `@${escapeHtml(decidedByUsername)}` : 'a manager';
  const verdict = decision === 'approved'
    ? `✅ <b>Approved</b> by ${by}`
    : `❌ <b>Not approved</b> by ${by}`;
  return [
    `🏠 <b>Home-Time Request — ${who}</b>`,
    '',
    verdict,
    `Home time: <b>${escapeHtml(request.home_from || '—')} → ${escapeHtml(request.home_to || '—')}</b>`,
  ].join('\n');
}

/** Announce an approved request to the employee group. Non-fatal on failure. */
async function announceApproval(telegram, request) {
  if (!config.employeeGroupId) return;
  const who = `${escapeHtml(request.driver_name || 'A driver')}`
    + `${request.unit_number ? ` (Unit ${escapeHtml(request.unit_number)})` : ''}`;
  const by = request.decided_by_username ? `@${escapeHtml(request.decided_by_username)}` : 'a manager';
  const text = `🏠 <b>Home Time Approved</b>\n`
    + `${who} requested home time from <b>${escapeHtml(request.home_from || '—')}</b> `
    + `to <b>${escapeHtml(request.home_to || '—')}</b>.\n`
    + `Approved by ${by}.`;
  try {
    await safeSend(() => telegram.sendMessage(config.employeeGroupId, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }));
  } catch (err) {
    console.error('[HOME-TIME-REQ] Failed to announce approval to employee group:', err.message);
  }
}

module.exports = {
  CALLBACK_PREFIX,
  handleApproverMention,
  generateRequestText,
  classifyHomeTimeRequest,
  buildCardText,
  buildDecisionButtons,
  buildDecidedCardText,
  announceApproval,
};
