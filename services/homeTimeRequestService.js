/**
 * Home-Time Request service.
 *
 * Triggered from the bot's group-message handler when a company rep tags an
 * approver (@tomr_robins0n / @SaffieBNett) in a DRIVER group. We:
 *   1. Look at the last ~30 minutes of that group's chat (in-memory buffer).
 *   2. Ask the AI whether this is actually a home-time request (reps get tagged
 *      for many reasons).
 *   3. If it is, work out how long the driver has been on the road (from the
 *      home-time tracker), write an AI note about the 4-week policy, and post it
 *      with "Approve" / "Do Not Approve" buttons that only the approvers can use.
 *   4. Record the request so the admin panel can flag policy violators later.
 *
 * The `telegram` instance is always passed in (never required) so this module
 * stays free of a require cycle with bot.js — same approach as homeTimeService.
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
} = require('./homeTimeRequestConstants');
const { wholeDaysBetween } = require('./homeTimeConstants');

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
    };
  } catch (_) {
    return { driverName: group.group_name || `Group ${group.id}`, unitNumber: null };
  }
}

/**
 * Ask the AI: is the recent conversation a home-time request?
 * Falls back to `true` when the AI is unavailable so a real request is never
 * silently dropped (approver tags are rare and worth surfacing to a human).
 */
async function classifyHomeTimeRequest(transcript) {
  const prompt = `You read a short Telegram transcript from a trucking company's driver group. `
    + `A company representative just tagged a manager. Decide if the conversation is the driver `
    + `ASKING FOR HOME TIME / time off / to go home (vs. tagged for any other reason such as a `
    + `load problem, paperwork, breakdown, or general question).\n\n`
    + `Transcript:\n"""\n${transcript || '(no recent messages)'}\n"""\n\n`
    + `Respond with JSON only: {"is_home_time_request": true|false, "reason": "<short>"}`;
  try {
    const { parsed } = await callGeminiJson({
      userText: prompt,
      maxOutputTokens: 200,
      validateParsed: (p) => typeof p?.is_home_time_request === 'boolean',
    });
    return {
      isRequest: Boolean(parsed.is_home_time_request),
      reason: String(parsed.reason || '').slice(0, 300),
      aiUsed: true,
    };
  } catch (err) {
    console.warn('[HOME-TIME-REQ] AI classification failed, defaulting to request:', err.message);
    return { isRequest: true, reason: 'AI unavailable — defaulted to request for human review.', aiUsed: false };
  }
}

/**
 * AI-written note for the card. Deterministic fallback keeps the exact policy
 * meaning when the AI is unavailable.
 */
async function generateRequestText({
  policyMet, daysOnRoad, allowanceWeeks, homeAllowanceDays, driverName,
}) {
  const weeks = daysOnRoad == null ? null : weeksFromDays(daysOnRoad);

  let situation;
  if (policyMet === true) {
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

  // Deterministic fallbacks (same meaning as the spec).
  if (policyMet === true) {
    return `I see it's been about ${weeks} weeks (${daysOnRoad} days) since you started driving, so I believe `
      + `you're good to have home time for ${homeAllowanceDays} days. But I'm still a bot, so I need a human's permission.`;
  }
  if (policyMet === false) {
    return `I see it hasn't been ${allowanceWeeks} weeks since you started driving — only about ${weeks} weeks `
      + `(${daysOnRoad} days). Per our agreement you should be on the road for at least ${allowanceWeeks} weeks. `
      + `I'm just a bot and can't decide on a human's behalf, so let the humans decide.`;
  }
  return `I couldn't confirm how long you've been on the road, so I can't check the ${allowanceWeeks}-week policy. `
    + `I'm just a bot, so let the humans decide.`;
}

function buildCardText({
  driverName, unitNumber, text, daysOnRoad, policyMet, homeFrom, homeTo,
}) {
  const who = `${escapeHtml(driverName)}${unitNumber ? ` (Unit ${escapeHtml(unitNumber)})` : ''}`;
  const flag = policyMet === false ? '⚠️ ' : '';
  const lines = [
    `🏠 <b>Home-Time Request — ${who}</b>`,
    '',
    `${flag}${escapeHtml(text)}`,
    '',
    `Proposed home time: <b>${escapeHtml(homeFrom)} → ${escapeHtml(homeTo)}</b>`,
  ];
  if (daysOnRoad != null) {
    lines.push(`On the road: <b>${daysOnRoad} days</b> (~${weeksFromDays(daysOnRoad)} weeks)`);
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

    // One open card per group at a time.
    const existing = await ht.getPendingHomeTimeRequestForGroup(group.id);
    if (existing) return;

    const transcript = recentBuffer.renderTranscript(group.telegram_group_id);
    const verdict = await classifyHomeTimeRequest(transcript);
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
    const policyMet = isPolicyMet(daysOnRoad, allowanceWeeks);

    const { driverName, unitNumber } = await resolveDriverLabel(group);
    const { homeFrom, homeTo } = computeHomeWindow(nowIso, homeAllowanceDays);

    const text = await generateRequestText({
      policyMet, daysOnRoad, allowanceWeeks, homeAllowanceDays, driverName,
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
      aiReasoning: verdict.reason || null,
    });

    const cardText = buildCardText({
      driverName, unitNumber, text, daysOnRoad, policyMet, homeFrom, homeTo,
    });
    const sent = await safeSend(() => telegram.sendMessage(group.telegram_group_id, cardText, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...buildDecisionButtons(request.id),
    }));
    await ht.setHomeTimeRequestMessage(request.id, group.telegram_group_id, sent?.message_id || null);

    console.log(`[HOME-TIME-REQ] Request #${request.id} posted for ${driverName} (policyMet=${policyMet}).`);
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
