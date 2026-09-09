/**
 * Populating the person layer from what the database already knows.
 *
 * The decision of WHO the people are lives in ./personBackfillPlan.js and is
 * pure; this module only loads the rows and, when asked, writes the plan.
 *
 * Two properties it must have, because it runs against a live fleet:
 *
 *   DRY RUN BY DEFAULT. `runPersonBackfill()` writes nothing and returns the
 *   plan. Nothing is applied unless a caller passes `apply: true`.
 *
 *   RE-RUNNABLE. A group that already has an open association is skipped, so a
 *   second run is a no-op and a run after new groups appear picks up only those.
 *   Re-running is how this stays useful after the first time, not a hazard.
 *
 * Everything is written in ONE transaction: a partial failure that left half the
 * fleet with people and half without would be worse than not running at all.
 */
const defaultDb = require('../../database/pool');
const { planPersonBackfill } = require('./personBackfillPlan');

/**
 * Every active driver group with the profile fields the plan needs.
 *
 * A plain read, not `listDriverProfiles()`, precisely because that function
 * auto-seeds a missing profile row — a write, which a dry run must not do.
 */
async function loadActiveDriverGroups(db = defaultDb) {
  const res = await db.query(
    `SELECT g.id AS group_id,
            g.group_name,
            dp.first_name,
            dp.last_name,
            dp.secondary_first_name,
            dp.secondary_last_name,
            dp.unit_number,
            dp.telegram_user_id,
            dp.date_of_birth
       FROM groups g
       LEFT JOIN driver_profiles dp ON dp.group_id = g.id
      WHERE g.group_type = 'driver'
        AND g.active = TRUE
      ORDER BY g.id`
  );
  return res.rows;
}

/** Group ids that already belong to somebody — the re-run guard. */
async function loadClaimedGroupIds(db = defaultDb) {
  const res = await db.query(
    'SELECT group_id FROM driver_person_groups WHERE ended_at IS NULL'
  );
  return new Set(res.rows.map((row) => row.group_id));
}

/** Unit numbers already assigned to somebody, so a re-run does not fight the index. */
async function loadClaimedUnits(db = defaultDb) {
  const res = await db.query(
    'SELECT unit_number FROM driver_units WHERE ended_at IS NULL'
  );
  return new Set(res.rows.map((row) => String(row.unit_number)));
}

async function applyPlan(plan, { claimedGroupIds, claimedUnits, db = defaultDb }) {
  const client = await db.pool.connect();
  const applied = {
    peopleCreated: 0, associationsOpened: 0, unitsOpened: 0,
    groupsSkipped: 0, unitsSkipped: 0,
  };
  try {
    await client.query('BEGIN');
    for (const person of plan.people) {
      const freshGroups = person.groups.filter((g) => !claimedGroupIds.has(g.groupId));
      applied.groupsSkipped += person.groups.length - freshGroups.length;
      // Every group of this person is already recorded — nothing to do, and
      // creating a second person for them would be the fragmentation this whole
      // layer exists to stop.
      if (!freshGroups.length) continue;

      const created = await client.query(
        `INSERT INTO driver_people (display_name, normalized_key, date_of_birth, created_source)
         VALUES ($1, $2, $3, 'backfill') RETURNING id`,
        [person.displayName, person.normalizedKey, person.dateOfBirth]
      );
      const personId = created.rows[0].id;
      applied.peopleCreated += 1;

      for (const g of freshGroups) {
        await client.query(
          `INSERT INTO driver_person_groups (person_id, group_id, association_source, confidence)
           VALUES ($1, $2, $3, $4)`,
          [personId, g.groupId, g.associationSource, g.confidence]
        );
        applied.associationsOpened += 1;
      }

      const unit = person.unitNumber ? String(person.unitNumber).trim() : null;
      if (unit && !claimedUnits.has(unit)) {
        await client.query(
          `INSERT INTO driver_units (person_id, unit_number, source)
           VALUES ($1, $2, 'group_title')`,
          [personId, unit]
        );
        claimedUnits.add(unit);
        applied.unitsOpened += 1;
      } else if (unit) {
        applied.unitsSkipped += 1;
      }
    }
    await client.query('COMMIT');
    return applied;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * @param {object} [options]
 * @param {boolean} [options.apply=false]  false = dry run, write nothing.
 * @param {object}  [options.db]  { pool, query } — injected like every other
 *   data dependency in this repo, so a test can point the whole run at a
 *   throwaway database without rewriting the module cache.
 * @returns {Promise<{plan: object, applied: object|null, dryRun: boolean}>}
 */
async function runPersonBackfill({ apply = false, db = defaultDb } = {}) {
  const rows = await loadActiveDriverGroups(db);
  const plan = planPersonBackfill(rows);

  const claimedGroupIds = await loadClaimedGroupIds(db);
  const claimedUnits = await loadClaimedUnits(db);
  plan.stats.alreadyClaimedGroups = claimedGroupIds.size;

  if (!apply) return { plan, applied: null, dryRun: true };
  const applied = await applyPlan(plan, { claimedGroupIds, claimedUnits, db });
  return { plan, applied, dryRun: false };
}

module.exports = {
  runPersonBackfill,
  loadActiveDriverGroups,
  loadClaimedGroupIds,
  loadClaimedUnits,
};
