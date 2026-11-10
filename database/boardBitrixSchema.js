'use strict';

/**
 * Last-known-good and candidate Bitrix schema state. The active mapping stays
 * on board_bitrix_settings; migration 0099 adds one catalogue-only candidate.
 */
const { pool, query } = require('./pool');
const { decideCandidate, REQUIRED_SEEN } = require('../lib/boardBitrix/schemaCandidate');

function mapActive(row) {
  if (!row?.schema_fingerprint) return null;
  return {
    mapping: row.schema_mapping || null,
    fingerprint: row.schema_fingerprint,
    source: row.schema_source || null,
    confidence: row.schema_confidence == null ? null : Number(row.schema_confidence),
    checkedAt: row.schema_checked_at || null,
  };
}

function mapCandidate(row) {
  if (!row) return null;
  return {
    state: row.state,
    mapping: row.mapping || null,
    fingerprint: row.fingerprint || null,
    source: row.source || null,
    confidence: row.confidence == null ? null : Number(row.confidence),
    seenCount: Number(row.seen_count || 0),
    requiresApproval: row.requires_approval === true,
    problem: row.problem || null,
    evidence: row.evidence || {},
    firstSeenAt: row.first_seen_at,
    checkedAt: row.checked_at,
  };
}

async function getSchemaState() {
  const [settings, candidate] = await Promise.all([
    query(`SELECT schema_mapping, schema_fingerprint, schema_source,
                  schema_confidence, schema_checked_at
             FROM board_bitrix_settings WHERE id = 1`),
    query('SELECT * FROM board_bitrix_schema_candidates WHERE id = 1'),
  ]);
  return { active: mapActive(settings.rows[0]), candidate: mapCandidate(candidate.rows[0]) };
}

async function writeActive(client, proposed, updatedBy = null) {
  await client.query(
    `UPDATE board_bitrix_settings
        SET schema_mapping = $1::jsonb, schema_fingerprint = $2,
            schema_source = $3, schema_confidence = $4,
            schema_checked_at = NOW(), sync_mode = 'off',
            updated_at = NOW(), updated_by = COALESCE($5, updated_by)
      WHERE id = 1`,
    [JSON.stringify(proposed.mapping), proposed.fingerprint, proposed.source,
      proposed.confidence, updatedBy]
  );
  await client.query('DELETE FROM board_bitrix_schema_candidates WHERE id = 1');
}

async function refreshActive(client, proposed) {
  await client.query(
    `UPDATE board_bitrix_settings
        SET schema_mapping = $1::jsonb, schema_source = $2,
            schema_confidence = $3, schema_checked_at = NOW()
      WHERE id = 1`,
    [JSON.stringify(proposed.mapping), proposed.source, proposed.confidence]
  );
  await client.query('DELETE FROM board_bitrix_schema_candidates WHERE id = 1');
}

async function observeCandidate(proposed) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const activeRes = await client.query(
      `SELECT schema_mapping, schema_fingerprint, schema_source,
              schema_confidence, schema_checked_at
         FROM board_bitrix_settings WHERE id = 1 FOR UPDATE`
    );
    const candidateRes = await client.query(
      'SELECT * FROM board_bitrix_schema_candidates WHERE id = 1 FOR UPDATE'
    );
    const active = mapActive(activeRes.rows[0]);
    const baseUnchanged = (active?.fingerprint || null) === (proposed.baseFingerprint || null);
    const decision = decideCandidate({
      active,
      current: mapCandidate(candidateRes.rows[0]),
      proposed,
      activeValid: proposed.activeValid === true && baseUnchanged,
      activeProven: proposed.activeProven === true && baseUnchanged,
      anomalous: proposed.anomalous === true || !baseUnchanged,
    });
    if (decision.useActive) {
      await refreshActive(client, proposed);
      await client.query('COMMIT');
      return { ...decision, status: 'active', mapping: proposed.mapping };
    }
    if (decision.promote) {
      await writeActive(client, proposed);
      await client.query('COMMIT');
      return { ...decision, status: 'active', mapping: proposed.mapping };
    }
    const problem = decision.requiresApproval
      ? proposed.problem || 'the Bitrix pipeline, process, category or fields changed from the last-known-good schema'
      : proposed.problem || null;
    await client.query(
      `INSERT INTO board_bitrix_schema_candidates
         (id, state, mapping, fingerprint, source, confidence, seen_count,
          requires_approval, problem, evidence, first_seen_at, checked_at, updated_at)
       VALUES (1, 'candidate', $1::jsonb, $2, $3, $4, $5, $6, $7, $8::jsonb,
               NOW(), NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET
         state = 'candidate', mapping = EXCLUDED.mapping,
         fingerprint = EXCLUDED.fingerprint, source = EXCLUDED.source,
         confidence = EXCLUDED.confidence, seen_count = EXCLUDED.seen_count,
         requires_approval = EXCLUDED.requires_approval,
         problem = EXCLUDED.problem, evidence = EXCLUDED.evidence,
         first_seen_at = CASE
           WHEN board_bitrix_schema_candidates.fingerprint = EXCLUDED.fingerprint
             THEN board_bitrix_schema_candidates.first_seen_at ELSE NOW() END,
         checked_at = NOW(), updated_at = NOW()`,
      [JSON.stringify(proposed.mapping), proposed.fingerprint, proposed.source,
        proposed.confidence, decision.seenCount, decision.requiresApproval,
        problem, JSON.stringify(proposed.evidence || {})]
    );
    await client.query('COMMIT');
    return { ...decision, status: 'candidate', mapping: proposed.mapping };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function recordInvalid({ problem, evidence = {} }) {
  await query(
    `INSERT INTO board_bitrix_schema_candidates
       (id, state, seen_count, requires_approval, problem, evidence, checked_at, updated_at)
     VALUES (1, 'invalid', 0, FALSE, $1, $2::jsonb, NOW(), NOW())
     ON CONFLICT (id) DO UPDATE SET
       state = 'invalid', mapping = NULL, fingerprint = NULL, source = NULL,
       confidence = NULL, seen_count = 0, requires_approval = FALSE,
       problem = EXCLUDED.problem, evidence = EXCLUDED.evidence,
       first_seen_at = NOW(), checked_at = NOW(), updated_at = NOW()`,
    [String(problem || 'schema discovery failed').replace(/\s+/g, ' ').slice(0, 240),
      JSON.stringify(evidence || {})]
  );
}

async function approveCandidate(updatedBy = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query(
      `SELECT * FROM board_bitrix_schema_candidates
        WHERE id = 1 AND state = 'candidate' FOR UPDATE`
    );
    const candidate = mapCandidate(res.rows[0]);
    if (!candidate || candidate.seenCount < REQUIRED_SEEN
      || Date.now() - new Date(candidate.checkedAt).getTime() > 30 * 60 * 1000) {
      await client.query('ROLLBACK');
      return null;
    }
    await writeActive(client, candidate, updatedBy);
    await client.query('COMMIT');
    return candidate;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { getSchemaState, observeCandidate, recordInvalid, approveCandidate };
