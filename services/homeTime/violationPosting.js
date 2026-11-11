'use strict';

/**
 * Posting home-time violation alerts to accounting — one message per home
 * stay, with Charged / Not charging — shared by the two ways a violation is
 * decided: Bitrix pipeline 33's cards (services/homeTime/violationAlerts.js,
 * the old script's) and Wenze's own record (services/homeTime/
 * ownViolations.js, since 11 November 2026). Rows come from
 * database/homeTime/violationNotices.js, each inserted exactly once; posting
 * takes a lease, and a failure is retried by the next pass.
 */

const V = require('../../lib/homeTime/violations');
const { safeSend } = require('../telegramHtml');

function log(text) {
  console.log(`[HOME-TIME-VIOLATION] ${text}`);
}

/** Post one message for these rows (one home stay). Never throws. */
async function postRows(rows, { telegram, chatId, deps }) {
  const claimed = await deps.store.claimForPosting(rows.map((r) => r.id));
  if (!claimed.length) return { posted: 0 };
  const ids = claimed.map((r) => r.id);
  const first = claimed[0];
  if (!telegram) {
    await deps.store.markFailed(ids, 'no telegram client available');
    return { failed: 1 };
  }
  const text = V.buildViolationMessage({
    driverName: first.driver_name,
    violations: claimed.map((r) => r.violation),
    roadDays: first.road_days,
    homeDays: first.home_days,
    homeFrom: first.home_from,
    mentions: deps.mentions,
    policy: first.rule_road_days != null || first.rule_home_days != null
      ? { roadDays: first.rule_road_days ?? V.POLICY.roadDays, homeDays: first.rule_home_days ?? V.POLICY.homeDays }
      : V.POLICY,
  });
  try {
    const sent = await safeSend(() => telegram.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: V.keyboardFor(first.id),
    }));
    await deps.store.markPosted(ids, { chatId, messageId: sent.message_id });
    log(`posted ${claimed.map((r) => r.violation).join(' + ')} for ${first.source === 'wenze' ? `driver group ${first.group_id}` : `deal ${first.deal_id}`}`);
    return { posted: 1 };
  } catch (err) {
    await deps.store.markFailed(ids, err.message);
    console.warn(`[HOME-TIME-VIOLATION] could not post ${first.source === 'wenze' ? `driver group ${first.group_id}` : `deal ${first.deal_id}`}: ${String(err.message).slice(0, 160)}`);
    return { failed: 1 };
  }
}

/** Retry what a failed or interrupted send left behind, one message per home stay. */
async function postDue({ telegram, chatId, deps }) {
  const due = await deps.store.listDue();
  const byStay = new Map();
  for (const row of due) {
    // A Wenze-decided stay may have no Bitrix card: its driver group names it.
    const key = `${row.source === 'wenze' ? `g${row.group_id}` : row.deal_id}:${row.home_from}`;
    if (!byStay.has(key)) byStay.set(key, []);
    byStay.get(key).push(row);
  }
  let posted = 0;
  for (const rows of byStay.values()) {
    // eslint-disable-next-line no-await-in-loop
    posted += (await postRows(rows, { telegram, chatId, deps })).posted || 0;
  }
  return posted;
}


module.exports = { postRows, postDue };
