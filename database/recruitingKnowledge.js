/**
 * What Wenze is allowed to tell a candidate.
 *
 * Two properties shape every function here.
 *
 * NOTHING IS EVER OVERWRITTEN. A rate changing from 70 to 77 cents produces a
 * new row that supersedes the old one; the old one stays, marked, with the
 * dates it was true. "What were we telling candidates in August" gets asked
 * after a dispute, and a table that overwrites cannot answer it.
 *
 * THE PERSON'S OWN WORDS ARE THE RECORD. `statement` is exactly what was typed.
 * A model's reading of it is stored separately in `understood_as`, so a later
 * misunderstanding can be traced to what Wenze thought at the time rather than
 * disappearing into a paraphrase that quietly became the record.
 */
const { query, pool } = require('./pool');

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    topic: row.topic,
    statement: row.statement,
    understoodAs: row.understood_as,
    status: row.status,
    supersedesId: row.supersedes_id,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    proposedBy: row.proposed_by,
    confirmedBy: row.confirmed_by,
    confirmedAt: row.confirmed_at,
    rejectedReason: row.rejected_reason,
    createdAt: row.created_at,
  };
}

/** Record what an administrator typed, and Wenze's reading of it. Not yet in use. */
async function proposeKnowledge({
  kind, topic, statement, understoodAs = null, supersedesId = null, proposedBy = null,
}) {
  const res = await query(
    `INSERT INTO recruiting_knowledge
       (kind, topic, statement, understood_as, supersedes_id, proposed_by, status)
     VALUES ($1,$2,$3,$4,$5,$6,'proposed')
     RETURNING *`,
    [kind, String(topic).trim(), String(statement).trim(), understoodAs, supersedesId, proposedBy]
  );
  return mapRow(res.rows[0]);
}

/**
 * Put a proposal into effect.
 *
 * One transaction, because "the new rate is live" and "the old rate is no
 * longer live" must be true at the same instant. Between them, a candidate
 * could be quoted both or neither.
 */
async function confirmKnowledge(id, { confirmedBy = null } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      'SELECT * FROM recruiting_knowledge WHERE id = $1 FOR UPDATE', [id]
    );
    const row = found.rows[0];
    if (!row) throw new Error(`No such knowledge entry: ${id}`);
    if (row.status !== 'proposed') {
      throw new Error(`Entry ${id} is already ${row.status}.`);
    }

    if (row.supersedes_id) {
      await client.query(
        `UPDATE recruiting_knowledge
            SET status = 'superseded', effective_to = NOW(), updated_at = NOW()
          WHERE id = $1 AND status = 'active'`,
        [row.supersedes_id]
      );
    }
    const updated = await client.query(
      `UPDATE recruiting_knowledge
          SET status = 'active', confirmed_by = $2, confirmed_at = NOW(),
              effective_from = NOW(), updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [id, confirmedBy]
    );
    await client.query('COMMIT');
    return mapRow(updated.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Turn a proposal down. The row stays, with the reason. */
async function rejectKnowledge(id, { reason = null, rejectedBy = null } = {}) {
  const res = await query(
    `UPDATE recruiting_knowledge
        SET status = 'rejected', rejected_reason = $2, confirmed_by = $3, updated_at = NOW()
      WHERE id = $1 AND status = 'proposed'
      RETURNING *`,
    [id, reason, rejectedBy]
  );
  return mapRow(res.rows[0]);
}

/** Take an active entry out of use without deleting what it said. */
async function retireKnowledge(id, { retiredBy = null } = {}) {
  const res = await query(
    `UPDATE recruiting_knowledge
        SET status = 'retired', effective_to = NOW(), confirmed_by = $2, updated_at = NOW()
      WHERE id = $1 AND status = 'active'
      RETURNING *`,
    [id, retiredBy]
  );
  return mapRow(res.rows[0]);
}

/**
 * Everything currently in force — the ONLY thing the recruiting AI may read.
 *
 * Corrections come last on purpose. They are written about a real mistake Wenze
 * made, so when a prompt is assembled they land closest to the instruction and
 * are the hardest thing for a model to lose track of.
 */
async function listActiveKnowledge() {
  const res = await query(
    `SELECT * FROM recruiting_knowledge
      WHERE status = 'active'
      ORDER BY CASE kind WHEN 'fact' THEN 1 WHEN 'boundary' THEN 2 ELSE 3 END,
               topic, created_at DESC`
  );
  return res.rows.map(mapRow);
}

/** The admin list: everything, newest first, including what awaits a decision. */
async function listKnowledgeForAdmin({ status = null, limit = 200 } = {}) {
  const res = await query(
    `SELECT * FROM recruiting_knowledge
      WHERE ($1::text IS NULL OR status = $1)
      ORDER BY
        CASE status WHEN 'proposed' THEN 0 ELSE 1 END,
        created_at DESC
      LIMIT $2`,
    [status, limit]
  );
  return res.rows.map(mapRow);
}

async function getKnowledge(id) {
  const res = await query('SELECT * FROM recruiting_knowledge WHERE id = $1', [id]);
  return mapRow(res.rows[0]);
}

/** The history of one fact: what it replaced, all the way back. */
async function knowledgeHistory(id) {
  const res = await query(
    `WITH RECURSIVE chain AS (
       SELECT * FROM recruiting_knowledge WHERE id = $1
       UNION ALL
       SELECT k.* FROM recruiting_knowledge k JOIN chain c ON k.id = c.supersedes_id
     )
     SELECT * FROM chain ORDER BY created_at DESC`,
    [id]
  );
  return res.rows.map(mapRow);
}

/** For /api/health and the admin: how much Wenze knows, and what awaits a person. */
async function summariseKnowledge() {
  const res = await query(
    `SELECT status, COUNT(*)::int AS n FROM recruiting_knowledge GROUP BY status`
  );
  const byStatus = Object.fromEntries(res.rows.map((r) => [r.status, r.n]));
  return {
    active: byStatus.active || 0,
    proposed: byStatus.proposed || 0,
    superseded: byStatus.superseded || 0,
    rejected: byStatus.rejected || 0,
    retired: byStatus.retired || 0,
  };
}

module.exports = {
  proposeKnowledge,
  confirmKnowledge,
  rejectKnowledge,
  retireKnowledge,
  listActiveKnowledge,
  listKnowledgeForAdmin,
  getKnowledge,
  knowledgeHistory,
  summariseKnowledge,
};
