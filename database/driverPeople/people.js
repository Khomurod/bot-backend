/**
 * The person row itself, and the merge pointer.
 *
 * A merge here is a POINTER, never a deletion: `merged_into_person_id` says
 * "this person turned out to be that person", and both rows — with every group
 * association and every unit assignment they carry — stay exactly where they
 * are. Undoing a merge is one column back to NULL. That is the whole reason the
 * identity layer is additive: an identity decision a human got wrong must cost
 * nothing to reverse.
 */
const { query } = require('../pool');

/** Follow the merge chain to the canonical row. Bounded, so a cycle cannot hang. */
const MAX_MERGE_DEPTH = 16;

function mapPerson(row) {
  if (!row) return null;
  return {
    id: row.id,
    displayName: row.display_name,
    normalizedKey: row.normalized_key,
    dateOfBirth: row.date_of_birth,
    notes: row.notes,
    mergedIntoPersonId: row.merged_into_person_id,
    createdSource: row.created_source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function createPerson({
  displayName,
  normalizedKey = null,
  dateOfBirth = null,
  notes = null,
  createdSource = 'backfill',
}, client = null) {
  const run = client ? client.query.bind(client) : query;
  const res = await run(
    `INSERT INTO driver_people (display_name, normalized_key, date_of_birth, notes, created_source)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [displayName, normalizedKey, dateOfBirth, notes, createdSource]
  );
  return mapPerson(res.rows[0]);
}

async function getPersonById(id) {
  const res = await query('SELECT * FROM driver_people WHERE id = $1', [id]);
  return mapPerson(res.rows[0]);
}

/**
 * The row a merged person now IS.
 *
 * Depth-bounded rather than recursive-CTE'd on purpose: the CHECK constraint
 * already forbids a self-merge, but a longer cycle written by a future bug must
 * degrade to "return what we have" instead of spinning.
 */
async function resolveCanonicalPerson(id) {
  let current = await getPersonById(id);
  for (let hops = 0; current && current.mergedIntoPersonId && hops < MAX_MERGE_DEPTH; hops += 1) {
    const next = await getPersonById(current.mergedIntoPersonId);
    if (!next || next.id === current.id) break;
    current = next;
  }
  return current;
}

/**
 * People sharing a normalized name.
 *
 * Deliberately returns a LIST. The key is not unique and must never be treated
 * as an identity — two humans really do normalize alike, which is the bug that
 * already exists in mileage_bonus_progress. Callers decide; this only narrows.
 */
async function findPeopleByNormalizedKey(normalizedKey, { includeMerged = false } = {}) {
  if (!normalizedKey) return [];
  const res = await query(
    `SELECT * FROM driver_people
      WHERE normalized_key = $1
        ${includeMerged ? '' : 'AND merged_into_person_id IS NULL'}
      ORDER BY id`,
    [normalizedKey]
  );
  return res.rows.map(mapPerson);
}

async function listPeople({ includeMerged = false, limit = 500 } = {}) {
  const res = await query(
    `SELECT * FROM driver_people
      ${includeMerged ? '' : 'WHERE merged_into_person_id IS NULL'}
      ORDER BY display_name, id
      LIMIT $1`,
    [limit]
  );
  return res.rows.map(mapPerson);
}

async function updatePerson(id, { displayName, normalizedKey, dateOfBirth, notes } = {}, client = null) {
  const run = client ? client.query.bind(client) : query;
  const sets = [];
  const values = [];
  const push = (column, value) => {
    if (value === undefined) return;
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };
  push('display_name', displayName);
  push('normalized_key', normalizedKey);
  push('date_of_birth', dateOfBirth);
  push('notes', notes);
  if (!sets.length) return getPersonById(id);
  values.push(id);
  const res = await run(
    `UPDATE driver_people SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = $${values.length} RETURNING *`,
    values
  );
  return mapPerson(res.rows[0]);
}

/**
 * Record that `personId` is really `intoPersonId`.
 *
 * Nothing is deleted and nothing moves. The guard against merging a row that is
 * itself already merged keeps the chain one hop deep in the normal case.
 */
async function mergePerson(personId, intoPersonId, client = null) {
  const run = client ? client.query.bind(client) : query;
  if (personId === intoPersonId) throw new Error('A person cannot be merged into themselves.');
  const res = await run(
    `UPDATE driver_people SET merged_into_person_id = $2, updated_at = NOW()
      WHERE id = $1 AND merged_into_person_id IS NULL
      RETURNING *`,
    [personId, intoPersonId]
  );
  return mapPerson(res.rows[0]);
}

/** Undo a merge. The single column that made it, set back to NULL. */
async function unmergePerson(personId, client = null) {
  const run = client ? client.query.bind(client) : query;
  const res = await run(
    `UPDATE driver_people SET merged_into_person_id = NULL, updated_at = NOW()
      WHERE id = $1 RETURNING *`,
    [personId]
  );
  return mapPerson(res.rows[0]);
}

module.exports = {
  MAX_MERGE_DEPTH,
  mapPerson,
  createPerson,
  getPersonById,
  resolveCanonicalPerson,
  findPeopleByNormalizedKey,
  listPeople,
  updatePerson,
  mergePerson,
  unmergePerson,
};
