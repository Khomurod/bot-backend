'use strict';

/**
 * Reading Bitrix24 for the Board ↔ Bitrix check: every driver deal in
 * pipeline 3 and every item of the "Trucks" smart process. READS ONLY —
 * `crm.deal.list` and `crm.item.list` over the shared bounded call
 * (services/bitrix24DealStages.js callBitrix); nothing here can write.
 *
 * THE ACTIVE LISTS MUST BE COMPLETE. A page that fails, an active list
 * longer than MAX_PAGES, a field Bitrix no longer returns, or a Trucks list
 * holding none of the trucks the active drivers point at throws — and the
 * pass stops before it decides anything. Resolving or asking from half a list
 * would call every driver on the missing pages "not in Bitrix".
 *
 * CLOSED DEALS ARE READ NEWEST FIRST, AND ONLY SO MANY. They grow forever
 * (every driver who ever left), and they only sharpen a question that is asked
 * anyway: a Board driver with no active deal is "closed in Bitrix" when their
 * closed deal is among the newest CLOSED_MAX_PAGES pages, and "no deal" when it
 * is older — both true, both something to fix. So a long closed list is never
 * a failure.
 */

const {
  DEAL_CATEGORY_ID, TRUCK_ENTITY_TYPE_ID, DEAL_FIELDS, DEAL_SELECT, TRUCK_SELECT,
  fleetFromDriverType, truckIdFromLink,
} = require('../../lib/boardBitrix/vocabulary');

const PAGE_SIZE = 50;
/** 2 000 active deals or trucks. Past that the read is incomplete, which is a failure. */
const MAX_PAGES = 40;
/** The newest 500 closed deals. */
const CLOSED_MAX_PAGES = 10;
/** When STAGE_SEMANTIC_ID is missing: the closed stages of pipeline 3. */
const CLOSED_STAGES = new Set(['C3:LOSE', 'C3:LEFT', 'C3:APOLOGY']);

function defaultDeps() {
  /* eslint-disable global-require */
  return { call: require('../bitrix24DealStages').callBitrix };
  /* eslint-enable global-require */
}

async function readPages(fetchPage, what, { maxPages = MAX_PAGES, mustFinish = true } = {}) {
  const rows = [];
  for (let page = 0; page < maxPages; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const batch = await fetchPage(page * PAGE_SIZE);
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return rows;
  }
  if (!mustFinish) return rows;
  throw new Error(`Bitrix has more than ${maxPages * PAGE_SIZE} ${what}; the list could not be read to the end, so nothing was compared`);
}

/** Pipeline 3's deals with this stage semantic ('P' active, 'F' closed). */
function dealPage(deps, semantic, order) {
  return async (start) => {
    const result = await deps.call('crm.deal.list', {
      filter: { CATEGORY_ID: DEAL_CATEGORY_ID, STAGE_SEMANTIC_ID: semantic },
      select: DEAL_SELECT,
      order: { ID: order },
      start,
    });
    return Array.isArray(result) ? result : [];
  };
}

function mapDeal(row) {
  const stageId = row.STAGE_ID || null;
  return {
    id: Number(row.ID),
    title: String(row.TITLE || '').trim(),
    stageId,
    semantic: row.STAGE_SEMANTIC_ID || (CLOSED_STAGES.has(stageId) ? 'F' : 'P'),
    fleetType: fleetFromDriverType(row[DEAL_FIELDS.driverType]),
    truckId: truckIdFromLink(row[DEAL_FIELDS.truck]),
  };
}

/**
 * @returns {Promise<{ deals: object[], trucks: object[] }>}
 * @throws a BitrixError (reason `not_configured` when Bitrix is not connected),
 *   or an Error when an active list is incomplete or a field is gone
 */
async function readBitrix(deps = defaultDeps()) {
  const active = await readPages(dealPage(deps, 'P', 'ASC'), 'active driver deals');
  const closed = await readPages(dealPage(deps, 'F', 'DESC'), 'closed driver deals', { maxPages: CLOSED_MAX_PAGES, mustFinish: false });

  const rawTrucks = await readPages(async (start) => {
    const result = await deps.call('crm.item.list', {
      entityTypeId: TRUCK_ENTITY_TYPE_ID,
      select: TRUCK_SELECT,
      order: { id: 'ASC' },
      start,
    });
    return Array.isArray(result?.items) ? result.items : [];
  }, 'trucks');

  // A field that was renamed comes back as nothing at all, on every row. Read
  // that as "every driver has no truck" and the group gets a hundred questions.
  for (const field of [DEAL_FIELDS.truck, DEAL_FIELDS.driverType]) {
    if (active.length && !active.some((r) => Object.prototype.hasOwnProperty.call(r, field))) {
      throw new Error(`Bitrix no longer returns the deal field ${field}; nothing was compared`);
    }
  }

  // The filter decides active or closed; a row whose own semantic says
  // otherwise is believed over the filter it came back under.
  const seen = new Set();
  const deals = [];
  for (const [rows, semantic] of [[active, 'P'], [closed, 'F']]) {
    for (const r of rows) {
      if (!r || !r.ID || seen.has(String(r.ID))) continue;
      seen.add(String(r.ID));
      deals.push(mapDeal({ STAGE_SEMANTIC_ID: semantic, ...r }));
    }
  }
  const trucks = rawTrucks.filter((t) => t && t.id).map((t) => ({ id: Number(t.id), title: t.title || '', stageId: t.stageId || null }));

  // Active drivers point at trucks, and not one of those trucks came back: the
  // Trucks list is empty or is the wrong one (a renamed smart process, a
  // webhook that cannot see it). Compared anyway, every driver would be "no
  // truck assigned" — a queue of false questions.
  const pointedAt = new Set(deals.filter((d) => d.semantic === 'P' && d.truckId).map((d) => d.truckId));
  const known = new Set(trucks.map((t) => t.id));
  if (pointedAt.size && ![...pointedAt].some((id) => known.has(id))) {
    throw new Error(`Bitrix returned none of the ${pointedAt.size} truck(s) the active drivers are assigned; nothing was compared`);
  }
  return { deals, trucks };
}

module.exports = { readBitrix, PAGE_SIZE, MAX_PAGES, CLOSED_MAX_PAGES, __test: { mapDeal } };
