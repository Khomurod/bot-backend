/**
 * Telling the three home-time managers what happened — once each.
 *
 * Three events, three notices, no buttons:
 *   requested    a driver (or a rep) asked for home time
 *   arrived_home Wenze has evidence the driver actually reached home
 *   back_on_road Wenze has evidence they returned to work
 *
 * WHY THIS IS A SERVICE AND NOT A `sendMessage` CALL. Every one of these events
 * is re-derived by something that runs repeatedly: the message pipeline sees the
 * same chat again, the return-to-road watcher ticks every few minutes, a deploy
 * restarts the process. Send-at-the-call-site means three managers get tagged
 * again each time. So nothing here sends directly: it RECORDS the event under a
 * key derived from the data (`arrived_home:412`), and the record is UNIQUE.
 * Delivery is a separate, retrying step over that record.
 *
 * The words come from lib/homeTime/managerNotice.js (pure). This file owns the
 * I/O: who the managers are, which chat, and the outbox.
 */
const ht = require('../../database/homeTime');
const people = require('../../database/driverPeople');
const { safeSend } = require('../telegramHtml');
const { HOME_TIME_MANAGER_MENTIONS } = require('../homeTimeRequestConstants');
const { buildNotice, eventKeyFor } = require('../../lib/homeTime/managerNotice');

/** Where staff home-time news goes. Same chat the request card used. */
function noticeChatId(settings) {
  const id = settings?.completed_notify_group_id;
  return id ? String(id) : null;
}

/** Best effort — a notice must never fail a state transition. */
async function personIdForGroup(groupId) {
  if (!groupId) return null;
  try {
    return await people.getPersonIdForGroup(groupId);
  } catch (err) {
    return null;
  }
}

/**
 * Record one event and try to deliver it immediately.
 *
 * Returns { recorded, delivered, notice }. `recorded: false` means this exact
 * event was already known — the normal, expected result of a repeated
 * background check, and the reason managers are not told twice.
 */
async function recordAndSend(telegram, {
  eventType, eventKey, payload, settings,
  groupId = null, personId = null, roadHistoryId = null, requestId = null,
  evidence = {},
}) {
  try {
    const chatId = noticeChatId(settings);
    if (!chatId) {
      console.warn(`[HOME-TIME-NOTICE] ${eventType}: no completed-notification group configured — not recorded.`);
      return { recorded: false, delivered: false, notice: null, reason: 'no_chat' };
    }
    const body = buildNotice(eventType, { ...payload, mentions: HOME_TIME_MANAGER_MENTIONS });
    const notice = await ht.enqueueNotice({
      eventKey, eventType, chatId, body,
      groupId,
      personId: personId ?? await personIdForGroup(groupId),
      roadHistoryId, requestId, evidence,
    });
    // Already recorded by an earlier pass: the managers have been told (or the
    // outbox is still retrying). Either way, do not tell them again.
    if (!notice) return { recorded: false, delivered: false, notice: null, reason: 'already_recorded' };

    // A new row is due immediately, so the sweep can pick it up while this call
    // is still inside a Telegram retry. Take the lease first; losing the race is
    // a success — the worker holding it will deliver.
    const claimed = await ht.claimNoticeById(notice.id);
    if (!claimed) {
      return { recorded: true, delivered: false, notice, reason: 'claimed_elsewhere' };
    }
    const delivered = await deliverOne(telegram, claimed);
    return { recorded: true, delivered, notice: claimed };
  } catch (err) {
    console.error(`[HOME-TIME-NOTICE] ${eventType} failed:`, err.message);
    return { recorded: false, delivered: false, notice: null, reason: 'error' };
  }
}

/** Send one recorded notice. Failure is recorded for the sweep, never thrown. */
async function deliverOne(telegram, notice) {
  if (!telegram) {
    await ht.markNoticeFailed(notice.id, 'no telegram client available').catch(() => {});
    return false;
  }
  try {
    const sent = await safeSend(() => telegram.sendMessage(notice.chatId, notice.body, {
      parse_mode: 'HTML', disable_web_page_preview: true,
    }));
    await ht.markNoticeDelivered(notice.id, { telegramMessageId: sent?.message_id || null });
    return true;
  } catch (err) {
    await ht.markNoticeFailed(notice.id, err.message).catch(() => {});
    console.warn(`[HOME-TIME-NOTICE] delivery of #${notice.id} failed (will retry):`, err.message);
    return false;
  }
}

// ── The three events ─────────────────────────────────────────────────────────

/** A. The driver ASKED for home time. An intention — not proof they are home. */
async function noticeHomeTimeRequested(telegram, {
  requestId, groupId, driverName, unitNumber, daysOnRoad, homeFrom, returnToRoadDate, settings,
}) {
  return recordAndSend(telegram, {
    eventType: 'request',
    eventKey: eventKeyFor('request', requestId),
    payload: { driverName, unitNumber, daysOnRoad, homeFrom, returnToRoadDate },
    settings, groupId, requestId,
    evidence: { daysOnRoad: daysOnRoad ?? null, homeFrom: homeFrom || null, returnToRoadDate: returnToRoadDate || null },
  });
}

/**
 * B. The driver IS home. Keyed on the road-history row the arrival opened, so
 * the notice and the home-time cycle are the same fact with the same identity.
 */
async function noticeDriverIsHome(telegram, {
  roadHistoryId, groupId, personId = null, driverName, unitNumber,
  homeSince, plannedReturn = null, daysOnRoad = null, settings, detectedBy = null,
}) {
  return recordAndSend(telegram, {
    eventType: 'arrived_home',
    eventKey: eventKeyFor('arrived_home', roadHistoryId),
    payload: { driverName, unitNumber, homeSince, plannedReturn, daysOnRoad },
    settings, groupId, personId, roadHistoryId,
    evidence: { homeSince: homeSince || null, daysOnRoad: daysOnRoad ?? null, detectedBy },
  });
}

/**
 * C. The driver went back to WORK. Keyed on the cycle that just closed.
 *
 * `eventKeySuffix` covers the case where no cycle was open to close — the state
 * was first observed as 'home', so there is no row to name. The key then
 * identifies the group and the moment, which is still ONE key per event rather
 * than one per background check that re-derives it.
 */
async function noticeDriverBackOnRoad(telegram, {
  roadHistoryId, eventKeySuffix = null, groupId, personId = null, driverName, unitNumber,
  endedAt, homeDays = null, evidenceSummary = null, settings, detectedBy = null,
}) {
  const subject = roadHistoryId || eventKeySuffix;
  if (!subject) {
    console.warn('[HOME-TIME-NOTICE] back_on_road with no cycle and no fallback key — not recorded.');
    return { recorded: false, delivered: false, notice: null, reason: 'no_event_key' };
  }
  return recordAndSend(telegram, {
    eventType: 'back_on_road',
    eventKey: eventKeyFor('back_on_road', subject),
    payload: { driverName, unitNumber, endedAt, homeDays, evidence: evidenceSummary },
    settings, groupId, personId, roadHistoryId,
    evidence: { endedAt: endedAt || null, homeDays: homeDays ?? null, detectedBy, summary: evidenceSummary || null },
  });
}

/**
 * Retry sweep. Rides an existing ticker rather than adding a timer of its own —
 * every notice is attempted inline first, so this only ever picks up the ones a
 * Telegram hiccup deferred.
 */
async function runManagerNoticeSweep(telegram, { limit = 10, nowIso = null } = {}) {
  const summary = { claimed: 0, delivered: 0, failed: 0 };
  try {
    const due = await ht.claimDueNotices({ limit, nowIso });
    summary.claimed = due.length;
    for (const notice of due) {
      // eslint-disable-next-line no-await-in-loop
      if (await deliverOne(telegram, notice)) summary.delivered += 1;
      else summary.failed += 1;
    }
  } catch (err) {
    console.error('[HOME-TIME-NOTICE] sweep failed:', err.message);
  }
  return summary;
}

module.exports = {
  noticeChatId,
  recordAndSend,
  deliverOne,
  noticeHomeTimeRequested,
  noticeDriverIsHome,
  noticeDriverBackOnRoad,
  runManagerNoticeSweep,
};
