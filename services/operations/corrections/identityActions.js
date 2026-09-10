/**
 * Correcting the person layer — two actions, both copying a fact already held.
 *
 * Split out of `actions.js` for the same reason `alertActions.js` was: that file
 * is near its size limit and this is a different domain. Same registry, same
 * tiering, same audit, same reversal.
 *
 *   identity.ensure_person   an active driver group with no person gets one —
 *                            the resolver's own decision (Telegram id → same
 *                            person; a returning name → same person; else new),
 *                            run inside the correction's transaction.
 *   identity.sync_unit       a person's recorded truck is brought to the truck
 *                            on their profile, when nobody else holds it.
 *
 * Neither invents anything: the group, the profile and the other people's
 * associations are the evidence, and both actions re-derive from the LIVE rows
 * under lock rather than trusting the sweep's payload.
 */
const { StaleCorrectionError } = require('./evidence');
const people = require('../../../database/driverPeople');
const lookups = require('../../../database/driverPeople/lookups');
const resolver = require('../../identity/personResolver');

const ensurePerson = {
  key: 'identity.ensure_person',
  tier: 'auto',
  subjectType: 'group',
  describe: (p) => `Give driver group ${p.groupId} a permanent identity`,

  async apply({ groupId }, client) {
    const g = await client.query(
      'SELECT id, group_name, group_type, active, samsara_vehicle_id FROM groups WHERE id = $1 FOR UPDATE',
      [groupId]
    );
    const group = g.rows[0];
    if (!group) throw new StaleCorrectionError(`Group ${groupId} no longer exists.`);
    if (group.group_type !== 'driver' || group.active !== true) {
      throw new StaleCorrectionError(`Group ${groupId} is no longer an active driver group.`);
    }
    const open = await people.getOpenAssociationForGroup(groupId, client);
    if (open) throw new StaleCorrectionError(`Group ${groupId} already belongs to person ${open.personId}.`);

    const result = await resolver.ensurePersonForGroup(group, { force: true, client });
    if (!result.personId) throw new StaleCorrectionError(`Group ${groupId} could not be placed (${result.action}).`);

    return {
      // The before-image is everything this write moved: the associations it
      // CLOSED (a returning driver's old chat) and the exact rows it stamped.
      oldValues: {
        personId: null,
        closedAssociations: (result.closedAssociations || []).map((a) => ({
          groupId: a.groupId, personId: a.personId, associationSource: a.associationSource, confidence: a.confidence,
        })),
      },
      newValues: {
        personId: result.personId, how: result.action, ambiguous: result.ambiguous === true,
        stamped: result.stamped || {},
      },
      affectedRecords: [
        { table: 'driver_person_groups', groupId, personId: result.personId },
        ...(result.action === 'create' ? [{ table: 'driver_people', id: result.personId }] : []),
      ],
    };
  },

  /**
   * Put the identity layer back as it was: close the association this opened,
   * reopen the ones it closed, and lift ONLY the stamps it wrote — a row that
   * already named the person, or was stamped by a later insert, is not this
   * write's to undo. The person row itself stays (nothing here deletes); a
   * created person with no groups is harmless and visible.
   */
  async revert(correction, client) {
    const groupId = Number(correction.subject_id);
    const personId = Number(correction.new_values?.personId);
    const open = await people.getOpenAssociationForGroup(groupId, client);
    if (!open || open.personId !== personId) {
      throw new StaleCorrectionError(`Group ${groupId} no longer belongs to person ${personId} — leaving it alone.`);
    }
    await people.closeGroupAssociation(groupId, {}, client);
    for (const closed of correction.old_values?.closedAssociations || []) {
      // Reopened only if nothing else has claimed that chat since.
      const held = await people.getOpenAssociationForGroup(closed.groupId, client);
      if (held) continue;
      await people.openGroupAssociation({
        personId: closed.personId, groupId: closed.groupId,
        associationSource: closed.associationSource || 'manual', confidence: closed.confidence ?? null,
      }, client);
    }
    await lookups.unstampRows(correction.new_values?.stamped, personId, client);
  },
};

const syncUnit = {
  key: 'identity.sync_unit',
  tier: 'auto',
  subjectType: 'group',
  describe: (p) => `Record unit ${p.unitNumber} as person ${p.personId}'s truck`,

  async apply({ personId, unitNumber, groupId }, client) {
    const unit = String(unitNumber || '').trim();
    if (!unit || !personId) throw new StaleCorrectionError('A person and a unit are both required.');

    // The evidence, locked: the profile that names the truck, and every open
    // unit row that could contradict the move.
    const profile = await client.query(
      'SELECT unit_number FROM driver_profiles WHERE group_id = $1 FOR UPDATE', [groupId]
    );
    if (String(profile.rows[0]?.unit_number || '').trim() !== unit) {
      throw new StaleCorrectionError(`Group ${groupId}'s profile no longer says unit ${unit}.`);
    }
    const association = await people.getOpenAssociationForGroup(groupId, client);
    if (!association || association.personId !== Number(personId)) {
      throw new StaleCorrectionError(`Group ${groupId} no longer belongs to person ${personId}.`);
    }
    // Two active chats for one person is ambiguous evidence about their truck;
    // the sweep does not propose in that state and the apply must not act in it.
    const activeChats = await client.query(
      `SELECT COUNT(*)::int AS n FROM driver_person_groups pg JOIN groups g ON g.id = pg.group_id
        WHERE pg.person_id = $1 AND pg.ended_at IS NULL AND g.active = TRUE AND g.group_type = 'driver'`,
      [personId]
    );
    if (activeChats.rows[0].n > 1) {
      throw new StaleCorrectionError(`Person ${personId} is on ${activeChats.rows[0].n} active chats — which truck is a decision.`);
    }
    // The chat's Samsara link travels onto the truck row, as it does on the
    // normal profile-save path — without it the vehicle-link check has only one
    // side to compare and goes quiet for exactly the driver just repaired.
    const groupRow = await client.query('SELECT samsara_vehicle_id FROM groups WHERE id = $1 FOR UPDATE', [groupId]);
    const samsaraVehicleId = groupRow.rows[0]?.samsara_vehicle_id || null;
    const openRows = await client.query(
      `SELECT id, person_id, unit_number, samsara_vehicle_id FROM driver_units
        WHERE ended_at IS NULL AND (person_id = $1 OR unit_number = $2)
        ORDER BY id FOR UPDATE`,
      [personId, unit]
    );
    const holder = openRows.rows.find((r) => String(r.unit_number).trim() === unit);
    if (holder && Number(holder.person_id) !== Number(personId)) {
      throw new StaleCorrectionError(`Unit ${unit} is now held by person ${holder.person_id} — not reassigning.`);
    }
    const current = openRows.rows.find((r) => Number(r.person_id) === Number(personId));
    if (current && String(current.unit_number).trim() === unit) {
      throw new StaleCorrectionError(`Person ${personId} already holds unit ${unit}.`);
    }

    if (current) await people.closeUnitAssignment({ personId }, client);
    const opened = await people.openUnitAssignment({
      personId, unitNumber: unit, samsaraVehicleId, source: 'profile',
    }, client);

    return {
      oldValues: {
        unitNumber: current ? current.unit_number : null,
        unitRowId: current ? current.id : null,
        samsaraVehicleId: current ? current.samsara_vehicle_id : null,
      },
      newValues: { unitNumber: unit, unitRowId: opened.id, samsaraVehicleId, personId },
      affectedRecords: [{ table: 'driver_units', id: opened.id, personId }],
    };
  },

  /** Close the row this opened and reopen the previous truck — a new row, never an edit of history. */
  async revert(correction, client) {
    const personId = Number(correction.affected_records?.[0]?.personId
      || correction.new_values?.personId);
    const opened = await client.query(
      'SELECT id, person_id, unit_number FROM driver_units WHERE id = $1 AND ended_at IS NULL FOR UPDATE',
      [correction.new_values?.unitRowId]
    );
    const row = opened.rows[0];
    if (!row) throw new StaleCorrectionError('The unit assignment this correction opened is no longer open.');
    await client.query('UPDATE driver_units SET ended_at = NOW() WHERE id = $1', [row.id]);
    const previous = correction.old_values?.unitNumber;
    if (previous) {
      await people.openUnitAssignment({
        personId: personId || row.person_id, unitNumber: previous,
        samsaraVehicleId: correction.old_values?.samsaraVehicleId || null, source: 'manual',
      }, client);
    }
  },
};

module.exports = { ensurePerson, syncUnit };
