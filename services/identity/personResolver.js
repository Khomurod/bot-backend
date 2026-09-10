/**
 * Keeping the person layer TRUE while the fleet moves — the writer the layer
 * never had.
 *
 * Phase 2 built `driver_people` and populated it once, by backfill. Nothing kept
 * it current, so the first truck change after the backfill would have made it
 * wrong. This module runs at the two moments identity actually changes:
 *
 *   A DRIVER GROUP IS SEEN (the bot's capture middleware). If the group has no
 *   person, one is resolved: the same Telegram account elsewhere → that person;
 *   the same name whose other chats have all gone inactive → that person, back
 *   on a new truck; otherwise a new person. The group's existing rows are
 *   stamped, so history written before the layer knew the person is not lost.
 *
 *   A PROFILE IS SAVED (admin, AI sync, backfill). The unit on the profile
 *   becomes the person's open unit — closing the previous one, so "truck 320
 *   → 322" is a recorded change of truck rather than a second driver. A unit
 *   another person still holds is NOT taken over: that is a contradiction for
 *   the watchdog, never a silent win for whoever was saved last.
 *
 * Decisions are pure (`lib/identity/personResolution.js`); this module loads the
 * evidence, writes the outcome in one transaction, and never throws into the
 * bot pipeline — a failure here is logged, and the message it rode in on is
 * processed exactly as before.
 */
const { pool } = require('../../database/pool');
const groupsDb = require('../../database/groups');
const driverProfilesDb = require('../../database/driverProfiles');
const people = require('../../database/driverPeople');
const lookups = require('../../database/driverPeople/lookups');
const { runPersonBackfill } = require('./personBackfillService');
const { buildNormalizedDriverKey, buildDriverDisplayName } = require('../../lib/drivers/driverProfileParse');
const { decidePersonForGroup, decideUnitSync } = require('../../lib/identity/personResolution');

/** A group is re-resolved at most this often from the message path. */
const ENSURE_TTL_MS = 10 * 60 * 1000;
const recentlyEnsured = new Map();

function resetResolverCache() {
  recentlyEnsured.clear();
}

function nameFields(profile, group) {
  return {
    first_name: profile?.first_name ?? null,
    last_name: profile?.last_name ?? null,
    secondary_first_name: profile?.secondary_first_name ?? null,
    secondary_last_name: profile?.secondary_last_name ?? null,
    fallbackGroupName: group?.group_name ?? profile?.group_name ?? null,
  };
}

async function withTransaction(work, existing = null) {
  // Inside a caller's transaction (a correction's apply), the caller owns
  // BEGIN/COMMIT; this only lends it the client.
  if (existing) return work(existing);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Make sure an active driver group has a person, and return who.
 *
 * @param {object} group  a `groups` row (id, group_name, group_type, active)
 * @param {object} [options]
 * @param {object|null} [options.profile]  the group's driver_profiles row when the caller has it
 * @param {boolean} [options.force]  bypass the per-process TTL
 * @param {object} [options.client]  run the writes on this client, inside the caller's transaction
 * @returns {Promise<{personId:number|null, action:string}>}
 */
async function ensurePersonForGroup(group, { profile = null, force = false, client: outer = null } = {}) {
  if (!group?.id || group.group_type !== 'driver' || group.active === false) {
    return { personId: null, action: 'skipped' };
  }
  const last = recentlyEnsured.get(group.id);
  if (!force && last && Date.now() - last < ENSURE_TTL_MS) {
    return { personId: await people.getPersonIdForGroup(group.id), action: 'cached' };
  }
  recentlyEnsured.set(group.id, Date.now());

  const open = await people.getOpenAssociationForGroup(group.id, outer);
  if (open) return { personId: open.personId, action: 'keep' };

  const prof = profile || await driverProfilesDb.getDriverProfileByGroupId(group.id);
  const fields = nameFields(prof, group);
  const normalizedKey = buildNormalizedDriverKey(fields);
  const [telegramAnchorPersonId, returningCandidates] = await Promise.all([
    lookups.findPersonByTelegramUserId(prof?.telegram_user_id, { excludeGroupId: group.id }, outer),
    lookups.findReturningCandidates(normalizedKey, { excludeGroupId: group.id }, outer),
  ]);
  const decision = decidePersonForGroup({ open: null, telegramAnchorPersonId, returningCandidates });

  const personId = await withTransaction(async (client) => {
    let id = decision.personId;
    if (decision.action === 'create') {
      const created = await people.createPerson({
        displayName: buildDriverDisplayName(fields) || group.group_name || `Group ${group.id}`,
        normalizedKey,
        dateOfBirth: prof?.date_of_birth || null,
        createdSource: 'bot',
      }, client);
      id = created.id;
    }
    for (const oldGroupId of decision.closeGroupIds || []) {
      await people.closeGroupAssociation(oldGroupId, {}, client);
    }
    await people.openGroupAssociation({
      personId: id,
      groupId: group.id,
      associationSource: decision.action === 'create' ? 'bot' : decision.source,
      confidence: decision.action === 'create' ? 80 : decision.confidence,
    }, client);
    await lookups.stampPersonIdForGroup(group.id, id, client);
    return id;
  }, outer);

  if (decision.action === 'link') {
    console.log(`[IDENTITY] Group ${group.id} linked to existing person ${personId} via ${decision.source}`);
  }
  return { personId, action: decision.action, ambiguous: decision.ambiguous === true };
}

/**
 * Record the truck a person is in now. Returns the pure decision plus what was
 * written, so a caller (and a test) can see a contested unit without a throw.
 */
async function syncUnitForPerson(personId, unitNumber, { source = 'profile', samsaraVehicleId = null } = {}) {
  if (!personId) return { action: 'noop', reason: 'no_person' };
  const [current, holder] = await Promise.all([
    people.getOpenUnitForPerson(personId),
    unitNumber ? people.getOpenPersonForUnit(String(unitNumber).trim()) : null,
  ]);
  const decision = decideUnitSync({
    personId,
    currentUnit: current?.unitNumber ?? null,
    targetUnit: unitNumber,
    holderPersonId: holder?.personId ?? null,
  });
  if (decision.action === 'noop' || decision.action === 'contested') {
    if (decision.action === 'contested') {
      console.warn(`[IDENTITY] Unit ${decision.unitNumber} is held by person ${decision.holderPersonId}; not reassigned to ${personId}`);
    }
    return decision;
  }
  await withTransaction(async (client) => {
    if (decision.action === 'switch') await people.closeUnitAssignment({ personId }, client);
    await people.openUnitAssignment({
      personId, unitNumber: decision.to, samsaraVehicleId, source,
    }, client);
  });
  return decision;
}

/**
 * A Telegram id arrived on a profile and it belongs to a person already on
 * record elsewhere. The group is moved to that person; the person it was given
 * on creation — if this was their only chat — is merged (a pointer) so nothing
 * dangles. Reversible: unmerge, and reopen the association.
 */
async function reconcileTelegramIdentity({ groupId, personId, telegramUserId }) {
  if (!groupId || !personId || !telegramUserId) return { merged: false, reason: 'incomplete' };
  const anchor = await lookups.findPersonByTelegramUserId(telegramUserId, { excludeGroupId: groupId });
  if (!anchor || anchor === personId) return { merged: false, reason: anchor ? 'same_person' : 'no_anchor' };

  const otherGroups = (await people.listGroupsForPerson(personId)).filter((a) => a.groupId !== groupId);
  await withTransaction(async (client) => {
    await people.closeGroupAssociation(groupId, {}, client);
    await people.openGroupAssociation({
      personId: anchor, groupId, associationSource: 'telegram_user_id', confidence: 100,
    }, client);
    await lookups.restampPersonIdForGroup(groupId, personId, anchor, client);
    if (otherGroups.length === 0) {
      // A merged row must hold no truck: left open, it would read as "another
      // holder" and make the anchor's own truck contested forever. The truck
      // itself is re-recorded for the anchor by the unit sync that follows,
      // from the profile — the evidence, rather than an inference from here.
      await people.closeUnitAssignment({ personId }, client);
      await people.mergePerson(personId, anchor, client);
    }
  });
  console.log(`[IDENTITY] Group ${groupId}: person ${personId} reconciled into ${anchor} by telegram_user_id`);
  return { merged: otherGroups.length === 0, movedTo: anchor, from: personId };
}

/**
 * The hook `database/driverProfiles` fires after every profile upsert.
 * Best effort by contract: it logs and returns; it never rejects into the save.
 */
async function onProfileSaved(profileRow) {
  try {
    if (!profileRow?.group_id) return null;
    const group = await groupsDb.getGroupByIdAnyType(profileRow.group_id);
    if (!group || group.group_type !== 'driver' || group.active === false) return null;
    const { personId } = await ensurePersonForGroup(group, { profile: profileRow, force: true });
    if (!personId) return null;
    let reconciled = null;
    if (profileRow.telegram_user_id) {
      reconciled = await reconcileTelegramIdentity({
        groupId: group.id, personId, telegramUserId: profileRow.telegram_user_id,
      });
    }
    const effectivePerson = reconciled?.movedTo || personId;
    const unit = await syncUnitForPerson(effectivePerson, profileRow.unit_number, {
      source: 'profile', samsaraVehicleId: group.samsara_vehicle_id || null,
    });
    return { personId: effectivePerson, unit, reconciled };
  } catch (err) {
    console.warn('[IDENTITY] profile hook failed:', err.message);
    return null;
  }
}

/**
 * The admin's "Run identity backfill": the Stage 1 plan, then stamp every
 * pre-existing row from the associations it created. Dry run unless `apply`.
 */
async function runIdentityBackfill({ apply = false } = {}) {
  const result = await runPersonBackfill({ apply });
  const stamped = apply ? await lookups.stampAllFromAssociations() : null;
  const coverage = await lookups.summariseIdentityCoverage();
  return { ...result, stamped, coverage };
}

module.exports = {
  ENSURE_TTL_MS,
  ensurePersonForGroup,
  syncUnitForPerson,
  reconcileTelegramIdentity,
  onProfileSaved,
  runIdentityBackfill,
  resetResolverCache,
};
