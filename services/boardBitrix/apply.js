'use strict';

/**
 * Doing one button's action in Bitrix (owner, 11 November 2026: the bot may
 * change Bitrix when a person presses the button; "if it is something I do
 * not want, I answer skip").
 *
 * BITRIX IS READ AGAIN FIRST. Every action carries what Bitrix said when it
 * was offered (lib/boardBitrix/actions.js `from…`); if the deal or truck has
 * moved since — somebody fixed it by hand, or changed it another way — the
 * action is refused and nothing is written. Already as asked: nothing is
 * written either. Then exactly one write: `crm.deal.update` with the one field
 * the action names. A truck item is never written (the owner, 13 November
 * 2026: the Trucks process is not the bot's to touch); a button saved under
 * an older question that would have moved a truck is refused as unknown.
 *
 * The field ids, pipeline and truck process come from the VALIDATED schema
 * mapping (Settings → Dispatcher Board); without one nothing is written —
 * the static fallback is for reading only.
 *
 * @returns {Promise<{ok: true, done: string} | {ok: false, why: string}>}
 *   never throws for Bitrix saying no; throws BitrixError when it cannot be asked
 */

const { truckIdFromLink } = require('../../lib/boardBitrix/vocabulary');
const { truckNumberFromTitle, sameTruckNumber } = require('../../lib/boardBitrix/trucks');
const { tidyName } = require('../../lib/boardBitrix/names');
const { activeSchemaSource } = require('../../lib/boardBitrix/schema');
const { attemptFromError } = require('../../lib/activityLog/entry');

const MAX_TRUCK_PAGES = 10;

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    call: require('../bitrix24DealStages').callBitrix,
    settings: () => require('../../database/boardBitrix').getSettings(),
    logAttempt: (attempt) => require('../activityLog/record').recordAttempt(attempt),
  };
  /* eslint-enable global-require */
}

const refuse = (why) => ({ ok: false, why });
/** The write was sent and Bitrix did not say yes — the client has already recorded it. */
const UNCONFIRMED = Object.freeze({ ok: false, why: 'Bitrix did not confirm the change', recorded: true });

async function readDeal(deps, id) {
  const deal = await deps.call('crm.deal.get', { id: Number(id) });
  return deal && deal.ID ? deal : null;
}

/**
 * THE WRITE, recorded by the client with who pressed and what changed
 * (Monitoring → Logs). `audit` is the press's context plus this fix's
 * from → to and the deal's title as it was read.
 */
async function updateDeal(deps, id, fields, audit) {
  let ok;
  try {
    ok = await deps.call('crm.deal.update', { id: Number(id), fields, params: { REGISTER_SONET_EVENT: 'Y' } }, { audit });
  } catch (err) {
    // The client recorded this write; `applyAction` must not record it again.
    if (err && typeof err === 'object') err.activityRecorded = true;
    throw err;
  }
  return ok === true;
}

/** The press's context for one fix: what it changes, on which deal. */
function auditFor(base, deal, change) {
  return {
    ...(base || {}),
    targetLabel: deal?.TITLE || null,
    change,
  };
}

async function trucksNumbered(deps, schema, number) {
  const found = [];
  for (let page = 0; page < MAX_TRUCK_PAGES; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const result = await deps.call('crm.item.list', {
      entityTypeId: schema.truckEntityTypeId,
      select: ['id', 'title', 'stageId', 'categoryId'],
      order: { id: 'ASC' },
      start: page * 50,
    });
    const items = Array.isArray(result?.items) ? result.items : [];
    for (const t of items) {
      if (sameTruckNumber(truckNumberFromTitle(t.title), number)) found.push({ id: Number(t.id), title: t.title, stageId: t.stageId });
    }
    if (items.length < 50) break;
  }
  const active = new Set(schema.activeTruckStageIds || []);
  const onRoad = found.filter((t) => active.has(t.stageId));
  return onRoad.length ? onRoad : found;
}

const HANDLERS = {
  async set_stage(p, deps, schema, audit) {
    const deal = await readDeal(deps, p.dealId);
    if (!deal) return refuse('the deal no longer exists in Bitrix');
    if (deal.STAGE_ID === p.stageId) return { ok: true, done: `already at ${p.stageName}`, already: true };
    if (p.fromStageId && deal.STAGE_ID !== p.fromStageId) return refuse('the deal\'s stage was changed meanwhile');
    const change = [{ field: 'STAGE_ID', from: deal.STAGE_ID, to: p.stageName ? `${p.stageName} (${p.stageId})` : p.stageId }];
    return (await updateDeal(deps, p.dealId, { STAGE_ID: p.stageId }, auditFor(audit, deal, change)))
      ? { ok: true, done: `moved to ${p.stageName}` } : UNCONFIRMED;
  },

  async set_title(p, deps, schema, audit) {
    const deal = await readDeal(deps, p.dealId);
    if (!deal) return refuse('the deal no longer exists in Bitrix');
    if (tidyName(deal.TITLE) === tidyName(p.title)) return { ok: true, done: 'already has that name', already: true };
    if (tidyName(deal.TITLE) !== tidyName(p.fromTitle)) return refuse('the deal was renamed meanwhile');
    const change = [{ field: 'TITLE', from: deal.TITLE, to: p.title }];
    return (await updateDeal(deps, p.dealId, { TITLE: p.title }, auditFor(audit, deal, change)))
      ? { ok: true, done: `renamed to "${p.title}"` } : UNCONFIRMED;
  },

  async set_driver_type(p, deps, schema, audit) {
    const field = schema.dealFields?.driverType;
    const deal = await readDeal(deps, p.dealId);
    if (!deal) return refuse('the deal no longer exists in Bitrix');
    const raw = Array.isArray(deal[field]) ? deal[field][0] : deal[field];
    const now = schema.fleetByDriverType?.[String(raw ?? '').trim()] || null;
    if (now === p.fleet) return { ok: true, done: 'already that driver type', already: true };
    if ((now || null) !== (p.fromFleet || null)) return refuse('the driver type was changed meanwhile');
    const change = [{ field: 'Driver type', from: now, to: p.fleet }];
    return (await updateDeal(deps, p.dealId, { [field]: p.value }, auditFor(audit, deal, change)))
      ? { ok: true, done: 'driver type set' } : UNCONFIRMED;
  },

  async set_truck(p, deps, schema, audit) {
    const field = schema.dealFields?.truck;
    const deal = await readDeal(deps, p.dealId);
    if (!deal) return refuse('the deal no longer exists in Bitrix');
    const now = truckIdFromLink(deal[field]);
    if ((now || null) !== (p.fromTruckId || null)) return refuse('the deal\'s truck was changed meanwhile');
    const trucks = await trucksNumbered(deps, schema, p.truckNumber);
    if (trucks.length !== 1) {
      return refuse(trucks.length ? `${trucks.length} trucks in Bitrix are numbered ${p.truckNumber}` : `no truck numbered ${p.truckNumber} in Bitrix`);
    }
    const change = [{ field: 'Assigned truck', from: now, to: `truck ${p.truckNumber} (item ${trucks[0].id})` }];
    return (await updateDeal(deps, p.dealId, { [field]: trucks[0].id }, auditFor(audit, deal, change)))
      ? { ok: true, done: `truck ${p.truckNumber} assigned` } : UNCONFIRMED;
  },
};

const ACTION_OF = Object.freeze({
  set_stage: 'deal.stage', set_title: 'deal.title', set_driver_type: 'deal.fields', set_truck: 'deal.fields',
});

/**
 * @param {object} action  a fix stored with the question's advice
 * @param {object} [deps]
 * @param {object} [audit]  who pressed or replied and why (Monitoring → Logs):
 *   `{actorKind, actorTelegramId, actorName, trigger, reason, evidence}`
 */
async function applyAction(action, deps = defaultDeps(), audit = null) {
  // Every attempt is an entry (decision c) — a refusal, an "already so", and
  // a press whose read got no answer. A write is recorded by the client.
  const log = (outcome) => (typeof deps.logAttempt === 'function'
    ? Promise.resolve(deps.logAttempt({
      action: ACTION_OF[action?.type] || 'deal.fields', targetId: action?.params?.dealId ?? null, audit, ...outcome,
    })).catch(() => {})
    : null);
  const handler = HANDLERS[action?.type];
  let out;
  try {
    if (!handler) {
      out = refuse('this is not something the bot can do');
    } else {
      const settings = await deps.settings();
      const schema = settings?.schemaMapping;
      out = (!schema?.dealFields || !schema?.truckEntityTypeId || !activeSchemaSource(settings.schemaSource))
        ? refuse('the Bitrix layout is not proven yet (Settings → Dispatcher Board) — please change it by hand')
        : await handler(action.params || {}, deps, schema, audit);
    }
  } catch (err) {
    // A read before the write got no answer (or Bitrix said no to it), or the
    // settings could not be read: that press is an entry too, then the
    // caller says "Bitrix did not answer". A write that threw is the client's.
    if (!err?.activityRecorded) await log(attemptFromError(err));
    throw err;
  }
  // A refusal or an "already so" wrote nothing — but it was a person's
  // attempt, and the timeline shows every attempt (a safety check's refusal).
  if ((!out.ok || out.already) && !out.recorded) {
    await log({ result: out.ok ? 'already_done' : 'refused', error: out.ok ? null : out.why });
  }
  return out;
}

module.exports = { applyAction, HANDLERS };
