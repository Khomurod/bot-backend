'use strict';

/**
 * Home-time violation alerts: Bitrix pipeline 33 → the accounting group.
 *
 * TWO WAYS IN, ONE WAY THROUGH. A Bitrix robot calls our webhook when a card
 * enters a violation stage (`handleWebhookDeal`), and a pass every thirty
 * minutes lists every card sitting in one (`runViolationPass`) — Bitrix does
 * not retry a webhook that failed. Both re-read the card from Bitrix and go
 * through `processDeal`, and both are safe to run at once: the table's UNIQUE
 * key decides which insert wins, and only the winner posts.
 *
 * WHAT IT WILL NOT DO:
 *   - decide a violation from the app's own home-time state;
 *   - post anything before a person switched it on AND saved a group;
 *   - post the history: the first pass after switching on records every card
 *     already in a violation stage as `baselined`, and posts none of them;
 *   - guess a missing "home since" date (the card is skipped and a finding
 *     filed), or carry on when Bitrix lacks the fields or stages it reads.
 *
 * See docs/architecture/home-time-violation-alerts.md.
 */

const V = require('../../lib/homeTime/violations');
const defaultStore = require('../../database/homeTime/violationNotices');
const { callBitrix } = require('../bitrix24DealStages');
const { ACCOUNTING_MENTIONS } = require('../mileageBonusConstants');
const { safeSend } = require('../telegramHtml');
const { withRunRecord } = require('../operations/runLedger');

const SERVICE_KEY = 'home_time_violation_alerts';
/** The webhook's shared secret lives in the environment (Coolify), never in the database. */
const SECRET_ENV = 'HOME_TIME_VIOLATION_WEBHOOK_SECRET';
const INCOMPLETE_KEY = 'home_time.violation_card_incomplete';
const POLL_MS = 30 * 60 * 1000;
const FIRST_TICK_DELAY_MS = 3 * 60 * 1000;
const PAGE_SIZE = 50;
const MAX_PAGES = 20;
const SCHEMA_OK_TTL_MS = 6 * 60 * 60 * 1000;

function log(text) {
  console.log(`[HOME-TIME-VIOLATION] ${text}`);
}

function defaultDeps() {
  // eslint-disable-next-line global-require
  const findings = require('../../database/operationalFindings');
  return {
    store: defaultStore,
    bitrix: callBitrix,
    findings,
    mentions: ACCOUNTING_MENTIONS,
    now: () => Date.now(),
  };
}

// ── does Bitrix still have what we read? ─────────────────────────────────────

let schemaOkUntil = 0;

/** Fields and stages, checked against Bitrix. A success is remembered for six hours; a failure never. */
async function checkBitrixSchema(deps) {
  if (deps.now() < schemaOkUntil) return { ok: true };
  const [fields, stages] = await Promise.all([
    deps.bitrix('crm.deal.fields', {}),
    deps.bitrix('crm.status.list', { filter: { ENTITY_ID: `DEAL_STAGE_${V.CATEGORY_ID}` } }),
  ]);
  const missingFields = V.missingFieldCodes(fields);
  const missingStages = V.missingStageIds(Array.isArray(stages) ? stages : []);
  if (missingFields.length || missingStages.length) return { ok: false, missingFields, missingStages };
  schemaOkUntil = deps.now() + SCHEMA_OK_TTL_MS;
  return { ok: true };
}

function schemaBlockedReason({ missingFields, missingStages }) {
  const parts = [];
  if (missingFields.length) parts.push(`fields ${missingFields.join(', ')}`);
  if (missingStages.length) parts.push(`stages ${missingStages.join(', ')}`);
  return `Bitrix pipeline ${V.CATEGORY_ID} is missing ${parts.join(' and ')}`;
}

// ── posting ──────────────────────────────────────────────────────────────────

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
  });
  try {
    const sent = await safeSend(() => telegram.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: V.keyboardFor(first.id),
    }));
    await deps.store.markPosted(ids, { chatId, messageId: sent.message_id });
    log(`posted ${claimed.map((r) => r.violation).join(' + ')} for deal ${first.deal_id}`);
    return { posted: 1 };
  } catch (err) {
    await deps.store.markFailed(ids, err.message);
    console.warn(`[HOME-TIME-VIOLATION] could not post deal ${first.deal_id}: ${String(err.message).slice(0, 160)}`);
    return { failed: 1 };
  }
}

/** Retry what a failed or interrupted send left behind, one message per home stay. */
async function postDue({ telegram, chatId, deps }) {
  const due = await deps.store.listDue();
  const byStay = new Map();
  for (const row of due) {
    const key = `${row.deal_id}:${row.home_from}`;
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

// ── one card ─────────────────────────────────────────────────────────────────

/**
 * One Bitrix card through the rules: record what is new for this home stay,
 * then post it — unless this is the baseline, which records and posts nothing.
 */
async function processDeal(row, {
  telegram, chatId, baseline = false, deps,
}) {
  const deal = V.readViolationDeal(row);
  if (!deal.ok) return { outcome: deal.reason, deal };
  const recorded = await deps.store.listRecordedViolations(deal.dealId, deal.homeFrom);
  const fresh = V.violationsToPost(deal.violations, recorded);
  if (!fresh.length) return { outcome: 'already_recorded', deal };
  const inserted = await deps.store.recordViolations({
    deal, violations: fresh, state: baseline ? 'baselined' : 'pending',
  });
  if (!inserted.length) return { outcome: 'already_recorded', deal };
  if (baseline) return { outcome: 'baselined', deal };
  const sent = await postRows(inserted, { telegram, chatId, deps });
  return { outcome: sent.posted ? 'posted' : 'post_failed', deal };
}

async function fileIncomplete(deps, deal) {
  const res = await deps.findings.upsertFinding({
    checkKey: INCOMPLETE_KEY,
    subjectType: 'bitrix_deal',
    subjectId: deal.dealId,
    title: `Bitrix home-time card ${deal.dealId} is in a violation stage with no "home since" date`,
    severity: 'warning',
    tier: 'warning',
    evidence: { dealId: deal.dealId, stageId: deal.stageId, missing: V.FIELDS.homeFrom },
  });
  return res?.id ?? null;
}

// ── the reconciliation pass ──────────────────────────────────────────────────

async function listViolationCards(deps) {
  const rows = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const result = await deps.bitrix('crm.deal.list', {
      filter: { CATEGORY_ID: V.CATEGORY_ID, STAGE_ID: V.VIOLATION_STAGE_IDS },
      select: V.DEAL_SELECT,
      order: { ID: 'ASC' },
      start: page * PAGE_SIZE,
    });
    const batch = Array.isArray(result) ? result : [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return { rows, complete: true };
  }
  return { rows, complete: false };
}

/**
 * Every card in a violation stage, compared with what was recorded. The first
 * pass after switching on is the baseline. Returns a run-ledger summary.
 */
async function runViolationPass({ telegram = null, deps = defaultDeps() } = {}) {
  const settings = await deps.store.getViolationSettings();
  if (!settings?.violation_alerts_enabled) return { blocked: 'switched off' };
  const chatId = settings.violation_alerts_chat_id;
  if (!chatId) return { blocked: 'no group saved' };

  let schema;
  try {
    schema = await checkBitrixSchema(deps);
  } catch (err) {
    // Not connected is configuration, not a failure; Bitrix being down is.
    if (err?.reason === 'not_configured') return { blocked: 'Bitrix24 is not connected' };
    throw err;
  }
  if (!schema.ok) return { blocked: schemaBlockedReason(schema) };

  const baseline = !settings.violation_alerts_baselined_at;
  const { rows, complete } = await listViolationCards(deps);
  const summary = {
    checked: rows.length, posted: 0, baselined: 0, incomplete: 0, retried: 0,
  };
  const keep = [];
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    const res = await processDeal(row, {
      telegram, chatId, baseline, deps,
    });
    if (res.outcome === 'posted') summary.posted += 1;
    if (res.outcome === 'baselined') summary.baselined += 1;
    if (res.outcome === 'no_home_from') {
      summary.incomplete += 1;
      // eslint-disable-next-line no-await-in-loop
      keep.push(await fileIncomplete(deps, res.deal));
    }
  }
  if (complete) await deps.findings.resolveClearedFindings([INCOMPLETE_KEY], keep.filter(Boolean));
  if (baseline) {
    await deps.store.markBaselined();
    log(`baseline: ${summary.baselined} card(s) already in a violation stage were recorded and NOT posted.`);
  } else {
    summary.retried = await postDue({ telegram, chatId, deps });
  }
  return summary;
}

// ── the webhook ──────────────────────────────────────────────────────────────

/**
 * A Bitrix robot named a deal. The robot's word is a hint: the card is read
 * again and the stage decides. Never throws — the webhook has already answered.
 */
async function handleWebhookDeal(dealId, { telegram = null, deps = defaultDeps() } = {}) {
  try {
    const settings = await deps.store.getViolationSettings();
    if (!settings?.violation_alerts_enabled || !settings.violation_alerts_chat_id) return { outcome: 'switched_off' };
    // Before the baseline the pass has not looked yet; it will, and records this card with the rest.
    if (!settings.violation_alerts_baselined_at) return { outcome: 'awaiting_baseline' };
    const schema = await checkBitrixSchema(deps);
    if (!schema.ok) return { outcome: 'schema_missing' };
    const row = await deps.bitrix('crm.deal.get', { id: Number(dealId) });
    const res = await processDeal(row, { telegram, chatId: settings.violation_alerts_chat_id, deps });
    if (res.outcome === 'no_home_from') await fileIncomplete(deps, res.deal);
    return { outcome: res.outcome };
  } catch (err) {
    // The pass will see the card within thirty minutes.
    console.warn(`[HOME-TIME-VIOLATION] webhook for deal ${dealId} failed: ${String(err.message).slice(0, 160)}`);
    return { outcome: 'error' };
  }
}

/** Whether the webhook secret is configured — for the settings card, which never sees it. */
function webhookSecretIsSet(env = process.env) {
  return Boolean(String(env[SECRET_ENV] || '').trim());
}

// ── the timer ────────────────────────────────────────────────────────────────

let timer = null;
let stopped = true;
let tickRunning = false;

async function tick(telegram) {
  if (tickRunning) return;
  tickRunning = true;
  try {
    const summary = await withRunRecord('home_time_violation_alerts', () => runViolationPass({ telegram }));
    if (summary?.posted || summary?.baselined || summary?.incomplete) {
      log(`${summary.checked} card(s) in violation stages — ${summary.posted} posted, `
        + `${summary.baselined} baselined, ${summary.incomplete} without a home-since date.`);
    }
  } catch (err) {
    console.error('[HOME-TIME-VIOLATION] pass error:', err.message);
  } finally {
    tickRunning = false;
    if (!stopped) {
      timer = setTimeout(() => tick(telegram), POLL_MS);
      timer.unref?.();
    }
  }
}

function startViolationAlerts(telegram) {
  stopped = false;
  timer = setTimeout(() => { if (!stopped) tick(telegram); }, FIRST_TICK_DELAY_MS);
  timer.unref?.();
}

function stopViolationAlerts() {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
}

module.exports = {
  SERVICE_KEY,
  SECRET_ENV,
  webhookSecretIsSet,
  INCOMPLETE_KEY,
  runViolationPass,
  handleWebhookDeal,
  processDeal,
  startViolationAlerts,
  stopViolationAlerts,
  __resetSchemaCacheForTests: () => { schemaOkUntil = 0; },
};
