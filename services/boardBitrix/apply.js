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

const MAX_TRUCK_PAGES = 10;

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    call: require('../bitrix24DealStages').callBitrix,
    settings: () => require('../../database/boardBitrix').getSettings(),
  };
  /* eslint-enable global-require */
}

const refuse = (why) => ({ ok: false, why });

async function readDeal(deps, id) {
  const deal = await deps.call('crm.deal.get', { id: Number(id) });
  return deal && deal.ID ? deal : null;
}

async function updateDeal(deps, id, fields) {
  const ok = await deps.call('crm.deal.update', { id: Number(id), fields, params: { REGISTER_SONET_EVENT: 'Y' } });
  return ok === true;
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
  async set_stage(p, deps) {
    const deal = await readDeal(deps, p.dealId);
    if (!deal) return refuse('the deal no longer exists in Bitrix');
    if (deal.STAGE_ID === p.stageId) return { ok: true, done: `already at ${p.stageName}` };
    if (p.fromStageId && deal.STAGE_ID !== p.fromStageId) return refuse('the deal\'s stage was changed meanwhile');
    return (await updateDeal(deps, p.dealId, { STAGE_ID: p.stageId }))
      ? { ok: true, done: `moved to ${p.stageName}` } : refuse('Bitrix did not confirm the change');
  },

  async set_title(p, deps) {
    const deal = await readDeal(deps, p.dealId);
    if (!deal) return refuse('the deal no longer exists in Bitrix');
    if (tidyName(deal.TITLE) === tidyName(p.title)) return { ok: true, done: 'already has that name' };
    if (tidyName(deal.TITLE) !== tidyName(p.fromTitle)) return refuse('the deal was renamed meanwhile');
    return (await updateDeal(deps, p.dealId, { TITLE: p.title }))
      ? { ok: true, done: `renamed to "${p.title}"` } : refuse('Bitrix did not confirm the change');
  },

  async set_driver_type(p, deps, schema) {
    const field = schema.dealFields?.driverType;
    const deal = await readDeal(deps, p.dealId);
    if (!deal) return refuse('the deal no longer exists in Bitrix');
    const raw = Array.isArray(deal[field]) ? deal[field][0] : deal[field];
    const now = schema.fleetByDriverType?.[String(raw ?? '').trim()] || null;
    if (now === p.fleet) return { ok: true, done: 'already that driver type' };
    if ((now || null) !== (p.fromFleet || null)) return refuse('the driver type was changed meanwhile');
    return (await updateDeal(deps, p.dealId, { [field]: p.value }))
      ? { ok: true, done: 'driver type set' } : refuse('Bitrix did not confirm the change');
  },

  async set_truck(p, deps, schema) {
    const field = schema.dealFields?.truck;
    const deal = await readDeal(deps, p.dealId);
    if (!deal) return refuse('the deal no longer exists in Bitrix');
    const now = truckIdFromLink(deal[field]);
    if ((now || null) !== (p.fromTruckId || null)) return refuse('the deal\'s truck was changed meanwhile');
    const trucks = await trucksNumbered(deps, schema, p.truckNumber);
    if (trucks.length !== 1) {
      return refuse(trucks.length ? `${trucks.length} trucks in Bitrix are numbered ${p.truckNumber}` : `no truck numbered ${p.truckNumber} in Bitrix`);
    }
    return (await updateDeal(deps, p.dealId, { [field]: trucks[0].id }))
      ? { ok: true, done: `truck ${p.truckNumber} assigned` } : refuse('Bitrix did not confirm the change');
  },
};

async function applyAction(action, deps = defaultDeps()) {
  const handler = HANDLERS[action?.type];
  if (!handler) return refuse('this is not something the bot can do');
  const settings = await deps.settings();
  const schema = settings?.schemaMapping;
  if (!schema?.dealFields || !schema?.truckEntityTypeId || !activeSchemaSource(settings.schemaSource)) {
    return refuse('the Bitrix layout is not proven yet (Settings → Dispatcher Board) — please change it by hand');
  }
  return handler(action.params || {}, deps, schema);
}

module.exports = { applyAction, HANDLERS };
