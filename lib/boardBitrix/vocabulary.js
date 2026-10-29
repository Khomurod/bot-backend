'use strict';

/**
 * The Dispatcher Board ↔ Bitrix24 check: what Bitrix calls things. PURE.
 *
 * Read from the portal on 29 October 2026 (read-only, by the owner's Bitrix
 * agent) — see docs/architecture/board-bitrix-check.md for the whole map.
 *
 *   a driver   a DEAL in pipeline 3 "4. DRIVER RELATION". Active means
 *              STAGE_SEMANTIC_ID 'P'; TERMINATED / LEFT / RESIGNED are 'F'.
 *              Pipeline 33 holds COPIES of the same drivers for home time and
 *              is never read here — counting it would double everybody.
 *   a truck    an item of the smart process "Trucks" (entityTypeId 1040).
 *              The truck number lives only inside its title ("Trucks #001").
 *   the link   the deal's UF_CRM_ASSIGNED_TRUCK holds the truck item's id.
 *              The old text field UF_CRM_DRV_TRUCK and the truck's parentId2
 *              are stale and never read.
 *
 * THE BOARD IS THE SOURCE OF TRUTH (the owner, 29 October 2026). Every
 * difference found is something to correct in Bitrix.
 */

const DEAL_CATEGORY_ID = 3;
const TRUCK_ENTITY_TYPE_ID = 1040;

const DEAL_FIELDS = Object.freeze({
  truck: 'UF_CRM_ASSIGNED_TRUCK',
  driverType: 'UF_CRM_PERF_DRIVER_TYPE',
});
const DEAL_SELECT = Object.freeze([
  'ID', 'TITLE', 'STAGE_ID', 'STAGE_SEMANTIC_ID', 'CATEGORY_ID', DEAL_FIELDS.truck, DEAL_FIELDS.driverType,
]);
const TRUCK_SELECT = Object.freeze(['id', 'title', 'stageId', 'categoryId']);

/** UF_CRM_PERF_DRIVER_TYPE → the Board's fleet vocabulary (lib/drivers/fleetType.js). */
const FLEET_BY_DRIVER_TYPE = Object.freeze({
  361: 'company',
  363: 'owner_operator',
  395: 'lease',
});
const FLEET_LABEL = Object.freeze({
  company: 'Company Driver',
  owner_operator: 'Owner Operator',
  lease: 'Lease Driver',
  unknown: 'not recognised',
});

/** Pipeline 3's stages, as a person reads them in Bitrix. */
const DEAL_STAGE_NAMES = Object.freeze({
  'C3:NEW': 'NEW',
  'C3:UC_UF0NDK': 'HOME',
  'C3:UC_XVD661': 'VACATION',
  'C3:UC_SHOP': 'SHOP',
  'C3:UC_XZ955I': 'WORKING',
  'C3:LOSE': 'TERMINATED',
  'C3:LEFT': 'TERMINATED / LEFT',
  'C3:APOLOGY': 'RESIGNED',
});
const STAGE = Object.freeze({
  HOME: 'C3:UC_UF0NDK',
  VACATION: 'C3:UC_XVD661',
  SHOP: 'C3:UC_SHOP',
  WORKING: 'C3:UC_XZ955I',
});

/**
 * The stage a deal should be in for what the Board says. The owner's mapping:
 * HOME ↔ HOME, SHOP ↔ SHOP, VACATION ↔ VACATION (a driver on vacation is not
 * working), and every working word ↔ WORKING. A status the Board invents
 * tomorrow maps to nothing, and nothing is compared — an unknown status is
 * never a conclusion (lib/board/statusSemantics.js says the same).
 */
const EXPECTED_STAGE_FOR_BOARD_STATUS = Object.freeze({
  HOME: STAGE.HOME,
  VACATION: STAGE.VACATION,
  SHOP: STAGE.SHOP,
  DISPATCHED: STAGE.WORKING,
  ENROUTE: STAGE.WORKING,
  READY: STAGE.WORKING,
  RESERVED: STAGE.WORKING,
  REST: STAGE.WORKING,
});

/** "On the road", "Drivers at shops", "Driver will stop soon and leave". */
const ACTIVE_TRUCK_STAGES = Object.freeze([
  'DT1040_17:UC_90RJVZ',
  'DT1040_17:UC_UNYJLF',
  'DT1040_17:UC_SO73F7',
]);
const TRUCK_STAGE_NAMES = Object.freeze({
  'DT1040_17:UC_90RJVZ': 'On the road',
  'DT1040_17:UC_UNYJLF': 'Drivers at shops',
  'DT1040_17:UC_SO73F7': 'Driver will stop soon and leave',
  'DT1040_17:SUCCESS': 'closed (success)',
  'DT1040_17:FAIL': 'closed (fail)',
});

const dealStageName = (stageId) => DEAL_STAGE_NAMES[stageId] || String(stageId || 'no stage');
const truckStageName = (stageId) => TRUCK_STAGE_NAMES[stageId] || 'not on the road';
const fleetLabel = (fleetType) => FLEET_LABEL[fleetType] || 'not set';

/** The deal's driver type as a fleet, or null when it is empty or not one of the three. */
function fleetFromDriverType(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  return FLEET_BY_DRIVER_TYPE[String(raw ?? '').trim()] || null;
}

/**
 * The truck item id a deal points at, or null. A CRM link field may come back
 * as a number, a numeric string, a prefixed id ("T418_3") or a one-element
 * array of any of those.
 */
function truckIdFromLink(value) {
  const raw = Array.isArray(value) ? value.find((v) => v !== null && v !== undefined && v !== '') : value;
  if (raw === null || raw === undefined) return null;
  const match = String(raw).trim().match(/(\d+)$/);
  const id = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

module.exports = {
  DEAL_CATEGORY_ID,
  TRUCK_ENTITY_TYPE_ID,
  DEAL_FIELDS,
  DEAL_SELECT,
  TRUCK_SELECT,
  STAGE,
  EXPECTED_STAGE_FOR_BOARD_STATUS,
  ACTIVE_TRUCK_STAGES,
  dealStageName,
  truckStageName,
  fleetLabel,
  fleetFromDriverType,
  truckIdFromLink,
};
