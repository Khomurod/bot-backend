'use strict';

/**
 * Bitrix deal stages → Meta Conversions API events. Pure: no I/O, no clock of
 * its own (the caller passes `nowMs`).
 *
 * WHICH STAGES SAY WHAT (the owner's mapping, 27 October 2026). Pipeline 0 is
 * the hiring pipeline every Facebook lead's deal lands in:
 *
 *   EXECUTING   Interested             → Qualified
 *   UC_PBR3LM   Documents              → Qualified
 *   UC_DISPATCH Talking to Dispatch    → Qualified
 *   UC_SAFETY   Sent to Safety         → Qualified
 *   WON         Hired                  → Converted
 *   LOSE        Lost                   → Lost
 *
 * New Lead, Contacting and "Lost – Qualified (call back later)" say NOTHING:
 * a lead nobody has reached yet is not evidence either way, and a candidate
 * parked for a call-back is neither won nor lost. A stage missing from this
 * table is silence, never a guess — a stage added in Bitrix later reports
 * nothing until somebody decides what it means here.
 *
 * WHY SEVEN DAYS. Meta refuses a server event whose `event_time` is more than
 * seven days in the past. A deal that moved before that is not reported at
 * all, rather than reported with a time it did not happen at.
 */

const STAGE_EVENTS = Object.freeze({
  EXECUTING: 'Qualified',
  UC_PBR3LM: 'Qualified',
  UC_DISPATCH: 'Qualified',
  UC_SAFETY: 'Qualified',
  WON: 'Converted',
  LOSE: 'Lost',
});

/** The pipeline whose stages the table above names. Other pipelines prefix their stage ids (`C33:…`). */
const CATEGORY_ID = '0';
const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** The `lead_event_source` Meta shows in Events Manager for these events. */
const LEAD_EVENT_SOURCE = 'Bitrix24';

/** The Meta event a stage reports, or null when the stage reports nothing. */
function eventForStage(stageId) {
  const key = String(stageId || '').trim();
  return Object.prototype.hasOwnProperty.call(STAGE_EVENTS, key) ? STAGE_EVENTS[key] : null;
}

/** A Meta leadgen id is a long decimal number. Anything else is not one. */
function isLeadgenId(value) {
  return /^\d{6,25}$/.test(String(value ?? '').trim());
}

/**
 * When the deal entered its stage, as epoch milliseconds, or null when Bitrix
 * gave nothing readable. MOVED_TIME is the stage change; DATE_MODIFY is any
 * edit, so it is only the fallback. A time in the future is clamped to now —
 * Meta refuses those too, and a server clock a minute ahead is not a reason to
 * lose the event.
 */
function stageChangedAtMs(deal, nowMs) {
  for (const raw of [deal?.MOVED_TIME, deal?.DATE_MODIFY]) {
    const ms = Date.parse(String(raw || ''));
    if (Number.isFinite(ms)) return Math.min(ms, nowMs);
  }
  return null;
}

function isFresh(eventTimeMs, nowMs) {
  return Number.isFinite(eventTimeMs) && nowMs - eventTimeMs < MAX_EVENT_AGE_MS;
}

/**
 * Which Bitrix id on a deal points back at the record the leads pipeline
 * created: the converted lead's id (`LEAD_ID`) when leads are created as
 * Bitrix LEADS — production's setting — or the deal's own id when they are
 * created as deals directly (BITRIX24_ENTITY=deal).
 */
function sourceRecordId(deal, entity) {
  const raw = entity === 'deal' ? deal?.ID : deal?.LEAD_ID;
  const id = String(raw ?? '').trim();
  return /^\d+$/.test(id) && id !== '0' ? id : null;
}

/**
 * The deals worth recording, with the leadgen id each belongs to. A deal whose
 * stage reports nothing, that is not a Facebook lead, or whose move is too old
 * for Meta is left out — and each reason is counted, so a pass that matched
 * nothing can say why.
 */
function planEvents({ deals, leadgenBySourceId, entity, nowMs }) {
  const plan = [];
  const skipped = { silent_stage: 0, not_facebook: 0, stale: 0, no_time: 0 };
  for (const deal of deals) {
    const eventName = String(deal?.CATEGORY_ID ?? '') === CATEGORY_ID ? eventForStage(deal?.STAGE_ID) : null;
    if (!eventName) { skipped.silent_stage += 1; continue; }
    const sourceId = sourceRecordId(deal, entity);
    const leadgenId = sourceId ? leadgenBySourceId.get(sourceId) : null;
    if (!isLeadgenId(leadgenId)) { skipped.not_facebook += 1; continue; }
    const eventTimeMs = stageChangedAtMs(deal, nowMs);
    if (eventTimeMs === null) { skipped.no_time += 1; continue; }
    if (!isFresh(eventTimeMs, nowMs)) { skipped.stale += 1; continue; }
    plan.push({
      leadgenId: String(leadgenId).trim(),
      eventName,
      dealId: Number(deal.ID),
      stageId: String(deal.STAGE_ID),
      eventTime: new Date(eventTimeMs),
    });
  }
  return { plan, skipped };
}

/**
 * One Conversions API event. `event_id` makes a resend after a crash (sent,
 * not yet marked sent) a duplicate Meta can discard instead of a second
 * conversion. `lead_id` goes as a number while it is exactly representable,
 * otherwise as the string Meta also accepts.
 */
function buildCapiEvent({ leadgenId, eventName, eventTime }) {
  const asNumber = Number(leadgenId);
  return {
    event_name: eventName,
    event_time: Math.floor(new Date(eventTime).getTime() / 1000),
    event_id: `bitrix:${leadgenId}:${eventName}`,
    action_source: 'system_generated',
    user_data: { lead_id: Number.isSafeInteger(asNumber) ? asNumber : String(leadgenId) },
    custom_data: { event_source: 'crm', lead_event_source: LEAD_EVENT_SOURCE },
  };
}

module.exports = {
  STAGE_EVENTS,
  CATEGORY_ID,
  MAX_EVENT_AGE_MS,
  eventForStage,
  isLeadgenId,
  stageChangedAtMs,
  isFresh,
  sourceRecordId,
  planEvents,
  buildCapiEvent,
};
