/**
 * Road Bonus Notifier service.
 *
 * DECIDED AFTER THE HOME STAY (owner's rule, 2026-10-06). A leg's bonus is
 * recorded when the driver gets home and decided only when they go back on the
 * road: home longer than the allowance → no bonus; a trip longer than six weeks
 * → held for a person (Needs Attention / Telegram) before anything is posted;
 * otherwise released. `lib/homeTime/roadBonusDecision.js` is the rule; this
 * pass applies it to every leg whose home stay has ended, then posts what was
 * released — and, for a forfeited leg, ONE short note saying why, so whoever
 * pays bonuses is not left wondering where it went.
 *
 * Posts the extra-week bonus as a SINGLE SUMMARY per completed leg, NOT
 * week-by-week while the driver is still out. While a driver stays on the road nothing is posted; the extra
 * weeks are simply accumulated. The moment they come home, one message goes to
 * the configured "Extra Week / Road Bonus" group stating how many FULL extra
 * weeks (beyond the road allowance) they completed and the total bonus owed.
 *
 * Scope: company_driver only (owner-operators earn $0, so they never qualify)
 * and only while home_time_settings.enabled.
 *
 * Idempotent + restart-safe (DB-side): each completed leg lives in
 * driver_road_history and carries a bonus_posted_at stamp. postCompletedRoadLeg
 * atomically claims a leg (stamps bonus_posted_at only if still NULL) before
 * sending, so the same completed leg is never announced twice — across restarts,
 * repeated syncs or repeated status updates. ONLY THIS POLLER posts: the
 * transition records the leg as waiting, and a decided leg that cannot be sent
 * (Telegram down, no group configured yet) is retried on the next pass.
 *
 * Destination is admin-configured (Settings → Telegram Groups). With no
 * configured group we do NOT fall back to any old hardcoded default — we skip
 * the send and log a clear configuration error, leaving the leg un-posted so it
 * is delivered once the group is set.
 */
const { DateTime } = require('luxon');
const ht = require('../database/homeTime');
const { safeSend } = require('./telegramHtml');
const messageGroups = require('../database/messageRoutingSettings');
const {
  homeTimePolicyApplies, DEFAULT_ROAD_ALLOWANCE_WEEKS, DAYS_PER_WEEK,
} = require('./homeTimeConstants');
const { inferDriverType } = require('../lib/drivers/driverProfileParse');
const { decideRoadBonus, DECISIONS } = require('../lib/homeTime/roadBonusDecision');
const { withRunRecord, noteHeartbeat } = require('./operations/runLedger');

// Safety-net sweep cadence. The primary post happens at the transition; this
// only catches legs the transition could not deliver, so a relaxed interval is
// plenty and keeps load negligible.
const POLL_MS = 10 * 60 * 1000;
const FIRST_TICK_DELAY_MS = 20 * 1000;

let serviceTimer = null;
let serviceStopped = false;
let tickRunning = false;
let telegramClient = null;

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function driverTypeFromRow(row) {
  return row?.driver_type || inferDriverType(row?.group_name || '');
}

/**
 * Build the single road→home summary for one completed leg.
 *
 * @param {object} p
 * @param {string} p.driverName
 * @param {string} [p.unitNumber]
 * @param {number} p.exceededWeeks  full extra weeks beyond the allowance
 * @param {number} p.allowanceWeeks the free road allowance in weeks
 * @param {number} p.daysOnRoad
 * @param {number} p.bonusUsd       total bonus owed for this leg
 */
function buildRoadLegSummary({
  driverName, unitNumber, exceededWeeks, allowanceWeeks, daysOnRoad, bonusUsd,
  homeDays = null, forfeitedReason = null,
}) {
  const who = `${escapeHtml(driverName)}${unitNumber ? ` (Unit ${escapeHtml(unitNumber)})` : ''}`;
  const weeksOnRoad = Math.floor(Number(daysOnRoad) / DAYS_PER_WEEK);
  const extra = Number(exceededWeeks) || 0;
  const extraLabel = extra === 1 ? 'extra week' : 'extra weeks';
  const bonus = Number(bonusUsd) || 0;
  const trip = `Completed <b>${weeksOnRoad} week(s)</b> on the road (${daysOnRoad} days) — `
    + `<b>${extra} ${extraLabel}</b> beyond the ${allowanceWeeks}-week allowance.`;
  if (forfeitedReason) {
    return `🚫 <b>${who} — no road bonus.</b>\n${trip}\n`
      + `The $${bonus.toFixed(0)} is not paid: ${escapeHtml(forfeitedReason)}.`;
  }
  const home = homeDays == null ? '' : `\nHome ${homeDays} day(s), within the allowance.`;
  return `🚚 <b>${who} — road bonus.</b>\n${trip}${home}\n`
    + `Needs a <b>total bonus of $${bonus.toFixed(0)}</b> for the extra week(s) on the road.`;
}

/**
 * Post the summary for ONE completed road leg, exactly once. Atomically claims
 * the leg first; if the claim is lost (already posted) it returns without
 * sending. Missing group configuration is surfaced as a clear error and the leg
 * is left un-posted for a later pass. On send failure the claim is released so
 * the leg is retried.
 *
 * @param {object} telegram  bot.telegram instance
 * @param {object} historyRow  a driver_road_history row (needs id + labels + totals)
 * @param {object} [opts]
 * @param {number} [opts.allowanceWeeks]  road allowance (falls back to default)
 * @returns {{ posted:boolean, reason?:string }}
 */
async function postCompletedRoadLeg(telegram, historyRow, { allowanceWeeks } = {}) {
  if (!historyRow || !(Number(historyRow.bonus_usd) > 0)) {
    return { posted: false, reason: 'no_bonus' };
  }
  const driverType = driverTypeFromRow(historyRow);
  if (!homeTimePolicyApplies(driverType)) return { posted: false, reason: 'owner_operator' };

  const chatId = await messageGroups.getGroupId('roadBonus');
  if (!chatId) {
    console.error(`[ROAD-BONUS] ${messageGroups.missingGroupMessage('roadBonus')} Leg #${historyRow.id} not posted.`);
    return { posted: false, reason: 'no_group' };
  }

  // Atomic claim — only one caller (transition or poller) ever posts a leg.
  const claimed = await ht.claimRoadBonusPost(historyRow.id);
  if (!claimed) return { posted: false, reason: 'already_posted' };

  const text = buildRoadLegSummary({
    driverName: claimed.driver_name || historyRow.driver_name || `Group ${claimed.group_id}`,
    unitNumber: claimed.unit_number || historyRow.unit_number || null,
    exceededWeeks: claimed.exceeded_weeks,
    allowanceWeeks: allowanceWeeks == null ? DEFAULT_ROAD_ALLOWANCE_WEEKS : allowanceWeeks,
    daysOnRoad: claimed.days_on_road,
    bonusUsd: claimed.bonus_usd,
    homeDays: claimed.home_days ?? null,
    forfeitedReason: claimed.bonus_decision === DECISIONS.FORFEITED
      ? (claimed.bonus_decision_reason || 'the home stay was longer than the allowance')
      : null,
  });

  try {
    await safeSend(() => telegram.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }));
    console.log(`[ROAD-BONUS] Posted road→home summary for leg #${claimed.id} ($${claimed.bonus_usd}).`);
    return { posted: true };
  } catch (err) {
    // Release the claim so the leg is retried on the next transition/poll.
    await ht.unclaimRoadBonusPost(historyRow.id).catch(() => {});
    throw err;
  }
}

/**
 * One safety-net pass: post any completed legs still awaiting their summary.
 * Pure-ish — pass `telegram` (and it reads settings for the allowance) so it can
 * be unit-tested deterministically.
 *
 * @returns {{ enabled:boolean, legs:number, notificationsSent:number, errors:number }}
 */
async function runRoadBonusCheck(telegram) {
  const settings = await ht.getHomeTimeSettings();
  if (!settings || !settings.enabled) {
    // SWITCHED OFF IS NOT HEALTHY AND IT IS NOT BROKEN. `statusFromSummary`
    // reads `blocked`; without it this returned a plain summary and the ledger
    // recorded a clean run, so a Home Time feature nobody has enabled looked
    // exactly like one posting bonuses every week.
    return {
      enabled: false, legs: 0, notificationsSent: 0, errors: 0,
      blocked: 'Home Time is switched off, so there are no road legs to post',
    };
  }
  const allowanceWeeks = Number(settings.road_allowance_weeks);

  // FIRST, DECIDE every leg whose home stay has now ended. Guarded on the state
  // read, so a second pass, or a person approving a held leg in the meantime,
  // is never overwritten.
  const decided = { released: 0, needsReview: 0, forfeited: 0 };
  const waiting = await ht.listRoadBonusesAwaitingDecision();
  for (const leg of waiting) {
    const verdict = decideRoadBonus(leg, { homeAllowanceDays: settings.home_allowance_days });
    if (!verdict || verdict.decision === DECISIONS.WAITING) continue;
    // eslint-disable-next-line no-await-in-loop
    const moved = await ht.setRoadBonusDecision(leg.id, {
      from: DECISIONS.WAITING, to: verdict.decision, reason: verdict.reason,
    }).catch((err) => {
      console.error(`[ROAD-BONUS] Could not decide leg #${leg.id}:`, err.message);
      return null;
    });
    if (!moved) continue;
    if (verdict.decision === DECISIONS.RELEASED) decided.released += 1;
    else if (verdict.decision === DECISIONS.REVIEW) decided.needsReview += 1;
    else if (verdict.decision === DECISIONS.FORFEITED) decided.forfeited += 1;
    console.log(`[ROAD-BONUS] Leg #${leg.id}: ${verdict.decision}${verdict.reason ? ` — ${verdict.reason}` : ''}`);
  }

  const rows = await ht.listUnpostedRoadBonuses();
  let notificationsSent = 0;
  let errors = 0;
  for (const row of rows) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await postCompletedRoadLeg(telegram, row, { allowanceWeeks });
      if (result.posted) notificationsSent += 1;
    } catch (err) {
      errors += 1;
      console.error(`[ROAD-BONUS] Failed to post leg #${row.id}:`, err.message);
    }
  }
  return {
    enabled: true, legs: rows.length, notificationsSent, errors, decided,
    // EVERY LEG FAILING is the pass not having run. One failed post among ten
    // is a leg to look at; ten out of ten is Telegram or the database refusing,
    // and `errors` — plural, and a NUMBER here — reaches the ledger through
    // nothing. `error`, singular, is the field it reads.
    ...(rows.length && errors === rows.length
      ? { error: `none of the ${rows.length} completed leg(s) could be posted` }
      : {}),
  };
}

async function tick() {
  if (tickRunning || !telegramClient) return;
  tickRunning = true;
  try {
    await withRunRecord('road_bonus_notifier', () => runRoadBonusCheck(telegramClient));
  } catch (err) {
    console.error('[ROAD-BONUS] Scheduler tick error:', err.message);
  } finally {
    tickRunning = false;
  }
}

function startRoadBonusNotifierService(telegram) {
  if (telegram) telegramClient = telegram;
  serviceStopped = false;
  console.log(`[ROAD-BONUS] Service started — sweeping unposted completed legs every ${POLL_MS / 60000}min`);
  setTimeout(() => { if (!serviceStopped) tick(); }, FIRST_TICK_DELAY_MS).unref?.();
  serviceTimer = setInterval(() => { if (!serviceStopped) tick(); }, POLL_MS);
  serviceTimer.unref?.();
}

function stopRoadBonusNotifierService() {
  serviceStopped = true;
  if (serviceTimer) {
    clearInterval(serviceTimer);
    serviceTimer = null;
  }
}

module.exports = {
  startRoadBonusNotifierService,
  stopRoadBonusNotifierService,
  runRoadBonusCheck,
  postCompletedRoadLeg,
  buildRoadLegSummary,
  tick,
};
