'use strict';

/**
 * Bitrix deal stages → Meta's Conversions API for CRM, so Facebook ad delivery
 * learns which leads become drivers (the owner, 27 October 2026).
 *
 * EVERY FIFTEEN MINUTES: list the hiring-pipeline deals Bitrix changed in the
 * last seven days, keep those whose stage reports something
 * (services/metaCrm/stageEvents.js) and that came from a Facebook lead, record
 * each (leadgen id, event) in `meta_crm_events`, then send what is pending —
 * one event per request, so one lead Meta refuses cannot sink the others.
 *
 * WHAT IT WILL NOT DO:
 *   - send anything while META_CRM_DATASET_ID or META_CRM_CAPI_TOKEN is unset
 *     (`blocked`, not a failure — it is waiting on configuration);
 *   - report a lead's event twice: the ledger's UNIQUE key decides, and a sent
 *     row is never pending again;
 *   - write to Bitrix. It reads deals and nothing else;
 *   - send a name, phone or e-mail. Meta matches on the leadgen id alone, which
 *     is Meta's own identifier for a lead Meta already holds;
 *   - retry forever: five attempts, or Meta's seven-day window, then `gave_up`.
 *
 * Seven days of deals is also the catch-up after an outage or a late
 * configuration: everything still inside Meta's window is reported on the first
 * pass that can.
 */

const { withRunRecord } = require('../operations/runLedger');
const {
  planEvents, buildCapiEvent, sourceRecordId, MAX_EVENT_AGE_MS, CATEGORY_ID,
} = require('./stageEvents');

const SERVICE_KEY = 'meta_crm_stage_sync';
const POLL_MS = 15 * 60 * 1000;
const FIRST_TICK_DELAY_MS = 4 * 60 * 1000;
const PAGE_SIZE = 50;
const MAX_PAGES = 40;
const MAX_SENDS_PER_PASS = 200;
const DEAL_SELECT = Object.freeze(['ID', 'LEAD_ID', 'CATEGORY_ID', 'STAGE_ID', 'MOVED_TIME', 'DATE_MODIFY']);

function log(text) {
  console.log(`[META-CRM] ${text}`);
}

function defaultDeps() {
  /* eslint-disable global-require */
  const config = require('../../config/config');
  return {
    config: () => ({
      datasetId: config.metaCrmDatasetId,
      token: config.metaCrmCapiToken,
      graphVersion: config.metaGraphVersion,
    }),
    // Lead or deal: the SAVED Bitrix settings win over BITRIX24_ENTITY, as for
    // every other Bitrix reader (database/bitrix.js → getBitrixConfig).
    bitrixEntity: async () => (await require('../../database/bitrix').getBitrixConfig()).entity,
    store: require('../../database/metaCrmEvents'),
    bitrix: require('../bitrix24DealStages').callBitrix,
    sendEvents: require('./capiClient').sendEvents,
    now: () => Date.now(),
  };
  /* eslint-enable global-require */
}

/** Bitrix's own date format, which `>=DATE_MODIFY` compares against. */
function bitrixDateTime(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

async function listRecentDeals(deps, sinceMs) {
  const rows = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const result = await deps.bitrix('crm.deal.list', {
      filter: { CATEGORY_ID: Number(CATEGORY_ID), '>=DATE_MODIFY': bitrixDateTime(sinceMs) },
      select: DEAL_SELECT,
      order: { ID: 'ASC' },
      start: page * PAGE_SIZE,
    });
    const batch = Array.isArray(result) ? result : [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return { rows, complete: true };
  }
  return { rows, complete: false };
}

async function sendDue(deps, cfg) {
  const due = await deps.store.listDue(MAX_SENDS_PER_PASS);
  const out = { sent: 0, failed: 0, gaveUp: 0, lastError: null };
  for (const row of due) {
    // eslint-disable-next-line no-await-in-loop
    const res = await deps.sendEvents({
      datasetId: cfg.datasetId,
      token: cfg.token,
      graphVersion: cfg.graphVersion,
      events: [buildCapiEvent({ leadgenId: row.leadgen_id, eventName: row.event_name, eventTime: row.event_time })],
    });
    if (res.ok) {
      // eslint-disable-next-line no-await-in-loop
      if (await deps.store.markSent(row.id)) out.sent += 1;
      continue;
    }
    out.failed += 1;
    out.lastError = res.error;
    // eslint-disable-next-line no-await-in-loop
    if ((await deps.store.markFailed(row.id, res.error)) === 'gave_up') out.gaveUp += 1;
  }
  return out;
}

/** One pass. Returns a run-ledger summary; throws only when the pass as a whole failed. */
async function runStageSyncPass({ deps = defaultDeps() } = {}) {
  const cfg = deps.config();
  if (!cfg.datasetId || !cfg.token) return { blocked: 'META_CRM_DATASET_ID and META_CRM_CAPI_TOKEN are not both set' };

  const nowMs = deps.now();
  let listed;
  try {
    listed = await listRecentDeals(deps, nowMs - MAX_EVENT_AGE_MS);
  } catch (err) {
    // Not connected is configuration, not a failure; Bitrix being down is.
    if (err?.reason === 'not_configured') return { blocked: 'Bitrix24 is not connected' };
    throw err;
  }

  const entity = await deps.bitrixEntity();
  const sourceIds = listed.rows.map((d) => sourceRecordId(d, entity)).filter(Boolean);
  const leadgenBySourceId = await deps.store.findLeadgenIdsByBitrixIds(sourceIds);
  const { plan, skipped } = planEvents({
    deals: listed.rows, leadgenBySourceId, entity, nowMs,
  });
  const recorded = await deps.store.recordEvents(plan);
  const sent = await sendDue(deps, cfg);

  const summary = {
    deals: listed.rows.length,
    complete: listed.complete,
    planned: plan.length,
    recorded: recorded.length,
    sent: sent.sent,
    failed: sent.failed,
    gave_up: sent.gaveUp,
    skipped,
  };
  // Every send failed and nothing went through: say so as a failure, with
  // Meta's own words, so a revoked token is red on /api/health, not silent.
  if (sent.failed && !sent.sent) {
    throw new Error(`all ${sent.failed} Meta send(s) failed — ${sent.lastError}`);
  }
  return summary;
}

// ── the timer ────────────────────────────────────────────────────────────────

let timer = null;
let stopped = true;
let tickRunning = false;

async function tick() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    const summary = await withRunRecord('meta_crm_stage_sync', () => runStageSyncPass());
    if (summary?.recorded || summary?.sent || summary?.failed) {
      log(`${summary.deals} deal(s) changed in 7 days — ${summary.recorded} new event(s), `
        + `${summary.sent} sent to Meta, ${summary.failed} failed.`);
    }
  } catch (err) {
    console.error('[META-CRM] pass error:', String(err.message).slice(0, 300));
  } finally {
    tickRunning = false;
    if (!stopped) {
      timer = setTimeout(tick, POLL_MS);
      timer.unref?.();
    }
  }
}

function startMetaCrmStageSync() {
  stopped = false;
  timer = setTimeout(() => { if (!stopped) tick(); }, FIRST_TICK_DELAY_MS);
  timer.unref?.();
}

function stopMetaCrmStageSync() {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
}

module.exports = {
  SERVICE_KEY,
  runStageSyncPass,
  startMetaCrmStageSync,
  stopMetaCrmStageSync,
  __test: { bitrixDateTime, listRecentDeals },
};
