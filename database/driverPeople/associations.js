/**
 * Person ↔ Telegram group, and person ↔ truck — both bounded in time.
 *
 * These two tables are what make "the driver changed truck" and "the driver came
 * back on a new chat" ordinary recorded events rather than new identities. An
 * association is CLOSED (ended_at) and a new one opened; the person row, and
 * every association before it, is untouched.
 *
 * Two partial unique indexes do the real work, and both are load-bearing:
 * one open association per group, and one open unit per person AND one open
 * person per unit. A write that would break them is not an error to route
 * around — it is the database refusing to record a contradiction (unit '001'
 * cannot be driven by four people at once), and the caller's job is to report
 * it, not to force it.
 */
const { query } = require('../pool');

function mapAssociation(row) {
  if (!row) return null;
  return {
    id: row.id,
    personId: row.person_id,
    groupId: row.group_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    associationSource: row.association_source,
    confidence: row.confidence,
  };
}

function mapUnit(row) {
  if (!row) return null;
  return {
    id: row.id,
    personId: row.person_id,
    unitNumber: row.unit_number,
    samsaraVehicleId: row.samsara_vehicle_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    source: row.source,
  };
}

// ─── Person ↔ group ──────────────────────────────────────────────────────────

async function openGroupAssociation({
  personId, groupId, associationSource = 'backfill', confidence = null, startedAt = null,
}, client = null) {
  const run = client ? client.query.bind(client) : query;
  const res = await run(
    `INSERT INTO driver_person_groups
       (person_id, group_id, association_source, confidence, started_at)
     VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, NOW()))
     RETURNING *`,
    [personId, groupId, associationSource, confidence, startedAt]
  );
  return mapAssociation(res.rows[0]);
}

/** Close the OPEN association for a group. Returns null when there was none. */
async function closeGroupAssociation(groupId, { endedAt = null } = {}, client = null) {
  const run = client ? client.query.bind(client) : query;
  const res = await run(
    `UPDATE driver_person_groups
        SET ended_at = COALESCE($2::timestamptz, NOW())
      WHERE group_id = $1 AND ended_at IS NULL
      RETURNING *`,
    [groupId, endedAt]
  );
  return mapAssociation(res.rows[0]);
}

async function getOpenAssociationForGroup(groupId) {
  const res = await query(
    'SELECT * FROM driver_person_groups WHERE group_id = $1 AND ended_at IS NULL',
    [groupId]
  );
  return mapAssociation(res.rows[0]);
}

/** Every group this person has ever been associated with, newest first. */
async function listGroupsForPerson(personId) {
  const res = await query(
    `SELECT * FROM driver_person_groups
      WHERE person_id = $1
      ORDER BY started_at DESC, id DESC`,
    [personId]
  );
  return res.rows.map(mapAssociation);
}

/** The person currently behind a chat, resolved through any merge. */
async function getPersonIdForGroup(groupId) {
  const association = await getOpenAssociationForGroup(groupId);
  return association ? association.personId : null;
}

// ─── Person ↔ truck ──────────────────────────────────────────────────────────

async function openUnitAssignment({
  personId, unitNumber, samsaraVehicleId = null, source = 'backfill', startedAt = null,
}, client = null) {
  const run = client ? client.query.bind(client) : query;
  const res = await run(
    `INSERT INTO driver_units
       (person_id, unit_number, samsara_vehicle_id, source, started_at)
     VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, NOW()))
     RETURNING *`,
    [personId, unitNumber, samsaraVehicleId, source, startedAt]
  );
  return mapUnit(res.rows[0]);
}

async function closeUnitAssignment({ personId = null, unitNumber = null, endedAt = null } = {}, client = null) {
  if (!personId && !unitNumber) throw new Error('closeUnitAssignment needs a personId or a unitNumber.');
  const run = client ? client.query.bind(client) : query;
  const res = await run(
    `UPDATE driver_units
        SET ended_at = COALESCE($3::timestamptz, NOW())
      WHERE ended_at IS NULL
        AND ($1::int IS NULL OR person_id = $1)
        AND ($2::text IS NULL OR unit_number = $2)
      RETURNING *`,
    [personId, unitNumber, endedAt]
  );
  return res.rows.map(mapUnit);
}

async function getOpenUnitForPerson(personId) {
  const res = await query(
    'SELECT * FROM driver_units WHERE person_id = $1 AND ended_at IS NULL',
    [personId]
  );
  return mapUnit(res.rows[0]);
}

async function getOpenPersonForUnit(unitNumber) {
  const res = await query(
    'SELECT * FROM driver_units WHERE unit_number = $1 AND ended_at IS NULL',
    [unitNumber]
  );
  return mapUnit(res.rows[0]);
}

async function listUnitsForPerson(personId) {
  const res = await query(
    'SELECT * FROM driver_units WHERE person_id = $1 ORDER BY started_at DESC, id DESC',
    [personId]
  );
  return res.rows.map(mapUnit);
}

module.exports = {
  mapAssociation,
  mapUnit,
  openGroupAssociation,
  closeGroupAssociation,
  getOpenAssociationForGroup,
  listGroupsForPerson,
  getPersonIdForGroup,
  openUnitAssignment,
  closeUnitAssignment,
  getOpenUnitForPerson,
  getOpenPersonForUnit,
  listUnitsForPerson,
};
