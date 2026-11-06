'use strict';

/**
 * What a reply typed in the owner's own words may CHANGE. PURE.
 *
 * THE OWNER'S DECISION, 6 November 2026: "I answer the bot in my own words and
 * it makes the change" — so a model may now PROPOSE A VALUE (a unit number, a
 * driver type, a truck), which the control channel had never allowed. Three
 * things keep that safe, and this file is the first:
 *
 *   1. A CLOSED LIST. A proposal names one operation below, on one of the chats
 *      the question was about, with values each operation validates. Nothing
 *      else can be proposed — not a field, not a table, not another driver.
 *   2. NOTHING IS WRITTEN FROM THE PROPOSAL. Wenze puts the exact change back to
 *      the owner as a new question (`services/control/confirmChange.js`), with
 *      the change stored on that question's own Yes. Only the owner's Yes to
 *      the change they can read applies it — the same rule as every other
 *      answer: a reply chooses what the question offered.
 *   3. IT GOES THROUGH THE CORRECTION REGISTRY like every other change: re-read
 *      under lock, refused when the record moved, audited, revertible.
 *
 * WHAT IS NOT HERE ON PURPOSE: anything in another system (the board,
 * Datatruck, Bitrix — Wenze only reads those), names (a person's identity is
 * not a one-word answer), deleting anything.
 */
const { normaliseOwner } = require('../drivers/truckIdentity');

const DRIVER_TYPES = Object.freeze(['owner', 'company_driver', 'lease']);
const FLEETS = Object.freeze(['company', 'owner_operator', 'lease']);
const STATUSES = Object.freeze(['active', 'inactive']);

const DRIVER_TYPE_WORD = Object.freeze({ owner: 'Owner-operator', company_driver: 'Company driver', lease: 'Lease driver' });
const FLEET_WORD = Object.freeze({ company: 'Company', owner_operator: 'Owner-operator', lease: 'Lease' });

const unitOf = (v) => String(v == null ? '' : v).trim().toUpperCase();
const UNIT_RE = /^\d{1,6}[A-Z]?$/;
const truckWords = (fleet, owner) => `${FLEET_WORD[fleet] || fleet} truck${owner ? ` of ${owner}` : ''}`;

/**
 * Each operation: what it is called to the model, its values, how a person
 * reads it, and which registered correction carries it out.
 */
const OPERATIONS = Object.freeze({
  set_unit: {
    says: 'the truck number in this chat\'s driver profile is wrong; set it to the number they give',
    values: 'unit_number: the truck number, digits with at most one trailing letter (e.g. "1", "010", "001A")',
    actionKey: 'profile.set_unit',
    read(values) {
      const unit = unitOf(values?.unit_number);
      return UNIT_RE.test(unit) ? { unitNumber: unit } : null;
    },
    same: (v, cur) => v.unitNumber === unitOf(cur.unitNumber),
    describe: (v, cur) => `unit ${cur.unitNumber || '(none)'} → ${v.unitNumber}`,
    payload: (v, cur, groupId) => ({ groupId, unitNumber: v.unitNumber, from: cur.unitNumber ?? null }),
  },
  set_driver_type: {
    says: 'the driver\'s own type is wrong (owner-operator, company driver or lease driver)',
    values: `driver_type: one of ${DRIVER_TYPES.join(', ')}`,
    actionKey: 'fleet.set_driver_type',
    read(values) {
      const t = String(values?.driver_type || '').trim().toLowerCase();
      return DRIVER_TYPES.includes(t) ? { driverType: t } : null;
    },
    same: (v, cur) => v.driverType === (cur.driverType || null),
    describe: (v, cur) => `driver type ${DRIVER_TYPE_WORD[cur.driverType] || 'not set'} → ${DRIVER_TYPE_WORD[v.driverType]}`,
    payload: (v, cur, groupId) => ({ groupId, from: cur.driverType ?? null, to: v.driverType }),
  },
  set_truck: {
    says: 'the TRUCK this driver drives is a different kind of truck: its fleet, and for an owner\'s truck the owner\'s name',
    values: `fleet: one of ${FLEETS.join(', ')}; owner: the truck owner's name as the board writes it, or null`,
    actionKey: 'profile.set_truck',
    read(values) {
      const fleet = String(values?.fleet || '').trim().toLowerCase();
      if (!FLEETS.includes(fleet)) return null;
      const owner = normaliseOwner(values?.owner);
      if (owner && !/^[A-Z][A-Z .'-]{0,39}$/.test(owner)) return null;
      return { fleet, owner: fleet === 'owner_operator' ? owner : null };
    },
    same: (v, cur) => v.fleet === (cur.truckFleet || null) && v.owner === (cur.truckOwner || null),
    describe: (v, cur) => `truck ${cur.truckFleet ? truckWords(cur.truckFleet, cur.truckOwner) : 'not recorded'} → ${truckWords(v.fleet, v.owner)}`,
    payload: (v, cur, groupId) => ({
      groupId, fleet: v.fleet, owner: v.owner, fromFleet: cur.truckFleet ?? null, fromOwner: cur.truckOwner ?? null,
    }),
  },
  set_status: {
    says: 'the driver is working (active) or not working any more (inactive)',
    values: `status: one of ${STATUSES.join(', ')}`,
    actionKey: 'identity.set_driver_status',
    read(values) {
      const s = String(values?.status || '').trim().toLowerCase();
      return STATUSES.includes(s) ? { status: s } : null;
    },
    same: (v, cur) => v.status === (cur.status || null),
    describe: (v, cur) => `status ${cur.status || 'not set'} → ${v.status}`,
    payload: (v, _cur, groupId) => ({ groupId, toStatus: v.status }),
  },
});

const OPERATION_KEYS = Object.freeze(Object.keys(OPERATIONS));
const TARGET_LETTERS = Object.freeze(['A', 'B', 'C', 'D']);

/**
 * Check a model's proposal against the catalogue and the chats it may touch.
 *
 * @param {object} parsed   {operation, target, values}
 * @param {Array<{letter, groupId, groupName, current}>} targets
 * @returns {{ok:true, change:object}|{ok:false, reason:string}}
 */
function validateProposal(parsed, targets = []) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'not an object' };
  const operation = String(parsed.operation || '');
  if (operation === 'none') return { ok: false, reason: 'no change in the reply' };
  const op = OPERATIONS[operation];
  if (!op) return { ok: false, reason: `operation "${operation}" is not in the catalogue` };
  const target = targets.find((t) => t.letter === String(parsed.target || '').trim().toUpperCase());
  if (!target) return { ok: false, reason: 'the target is not one of the chats offered' };
  const values = op.read(parsed.values || {});
  if (!values) return { ok: false, reason: `the values do not fit ${operation}` };
  const current = target.current || {};
  if (op.same(values, current)) return { ok: false, reason: 'the profile already says that' };
  return {
    ok: true,
    change: {
      operation,
      groupId: target.groupId,
      groupName: target.groupName || null,
      values,
      from: current,
    },
  };
}

/** The change in words, as the owner will confirm it. */
function describeChange(change) {
  const op = OPERATIONS[change?.operation];
  if (!op) return null;
  return `${change.groupName || `Group ${change.groupId}`}: ${op.describe(change.values, change.from || {})}`;
}

/** The registered correction and its payload for a confirmed change; null when it no longer reads. */
function correctionFor(change) {
  const op = OPERATIONS[change?.operation];
  if (!op || !change.groupId) return null;
  const values = op.read(toModelValues(change));
  if (!values) return null;
  return { actionKey: op.actionKey, payload: op.payload(values, change.from || {}, Number(change.groupId)) };
}

/** A stored change's values back in the shape `read` takes — so a stored change is validated again, not trusted. */
function toModelValues(change) {
  const v = change.values || {};
  return {
    unit_number: v.unitNumber, driver_type: v.driverType, fleet: v.fleet, owner: v.owner, status: v.status,
  };
}

module.exports = {
  OPERATIONS, OPERATION_KEYS, TARGET_LETTERS, validateProposal, describeChange, correctionFor,
};
