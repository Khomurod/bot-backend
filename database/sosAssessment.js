/**
 * SOS assessment — data access layer (tables from migration 0003).
 *
 * Deliberately separate from the Telegram driver-feedback survey tables
 * (questions/options/responses). Not spread into database/db.js — require this
 * module directly. Submissions are written in one transaction together with
 * their 10 answer snapshots; results are stored at submit time and never
 * recomputed, so a stored result can never change.
 */

const { pool, query } = require('./pool');

function mapSubmission(row) {
  if (!row) return null;
  return {
    id: row.id,
    fullName: row.full_name,
    nameNormalized: row.name_normalized,
    department: row.department,
    dispatchTeamId: row.dispatch_team_id,
    dispatchTeamName: row.dispatch_team_name,
    language: row.language,
    contentVersion: row.content_version,
    patternScores: row.pattern_scores,
    primaryPattern: row.primary_pattern,
    secondaryPattern: row.secondary_pattern,
    duplicateConfirmed: row.duplicate_confirmed,
    createdAt: row.created_at,
    ...(row.duplicate_count !== undefined ? { duplicateCount: Number(row.duplicate_count) } : {}),
  };
}

async function getSettings() {
  const res = await query('SELECT is_open, updated_at FROM sos_settings WHERE id = 1');
  const row = res.rows[0];
  return { isOpen: row ? row.is_open === true : false, updatedAt: row ? row.updated_at : null };
}

async function setOpen(isOpen) {
  const res = await query(
    'UPDATE sos_settings SET is_open = $1, updated_at = NOW() WHERE id = 1 RETURNING is_open, updated_at',
    [isOpen === true],
  );
  const row = res.rows[0];
  return { isOpen: row.is_open === true, updatedAt: row.updated_at };
}

/** Latest submission with the same normalized name + department, if any. */
async function findDuplicate(nameNormalized, department) {
  const res = await query(
    `SELECT id, created_at FROM sos_submissions
      WHERE name_normalized = $1 AND department = $2
      ORDER BY created_at DESC LIMIT 1`,
    [nameNormalized, department],
  );
  return res.rows[0] ? { id: res.rows[0].id, createdAt: res.rows[0].created_at } : null;
}

/**
 * Inserts the submission and its answer snapshots atomically.
 * @returns {{id: number, createdAt: Date}}
 */
async function createSubmission(input) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const subRes = await client.query(
      `INSERT INTO sos_submissions
         (full_name, name_normalized, department, dispatch_team_id, dispatch_team_name,
          language, content_version, pattern_scores, primary_pattern, secondary_pattern,
          result_token, duplicate_confirmed, client_ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id, created_at`,
      [
        input.fullName,
        input.nameNormalized,
        input.department,
        input.dispatchTeamId ?? null,
        input.dispatchTeamName ?? null,
        input.language,
        input.contentVersion,
        JSON.stringify(input.patternScores),
        input.primaryPattern,
        input.secondaryPattern ?? null,
        input.resultToken,
        input.duplicateConfirmed === true,
        input.clientIp ?? null,
      ],
    );
    const submissionId = subRes.rows[0].id;
    for (const answer of input.answers) {
      await client.query(
        `INSERT INTO sos_answers (submission_id, question_key, option_key, pattern, weight, position)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [submissionId, answer.questionKey, answer.optionKey, answer.pattern, answer.weight, answer.position],
      );
    }
    await client.query('COMMIT');
    return { id: submissionId, createdAt: subRes.rows[0].created_at };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Result re-view via capability token. Excludes name/ip on purpose. */
async function getSubmissionByToken(resultToken) {
  const res = await query(
    `SELECT language, department, content_version, pattern_scores,
            primary_pattern, secondary_pattern, created_at
       FROM sos_submissions WHERE result_token = $1`,
    [resultToken],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    language: row.language,
    department: row.department,
    contentVersion: row.content_version,
    patternScores: row.pattern_scores,
    primaryPattern: row.primary_pattern,
    secondaryPattern: row.secondary_pattern,
    createdAt: row.created_at,
  };
}

/** Admin list with filters; duplicateCount flags likely duplicates. */
async function listSubmissions({ department, dispatchTeamId, pattern, search, limit = 500 } = {}) {
  const where = [];
  const values = [];
  const add = (sqlForIndex, value) => { values.push(value); where.push(sqlForIndex(`$${values.length}`)); };
  if (department) add((i) => `department = ${i}`, department);
  if (dispatchTeamId) add((i) => `dispatch_team_id = ${i}`, dispatchTeamId);
  if (pattern) add((i) => `(primary_pattern = ${i} OR secondary_pattern = ${i})`, pattern);
  if (search) add((i) => `full_name ILIKE ${i}`, `%${search}%`);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  values.push(Math.min(Number(limit) || 500, 2000));
  const res = await query(
    `SELECT *, COUNT(*) OVER (PARTITION BY name_normalized, department) AS duplicate_count
       FROM sos_submissions ${whereSql}
      ORDER BY created_at DESC
      LIMIT $${values.length}`,
    values,
  );
  return res.rows.map(mapSubmission);
}

async function getSubmissionDetail(id) {
  const subRes = await query('SELECT * FROM sos_submissions WHERE id = $1', [id]);
  if (!subRes.rows[0]) return null;
  const ansRes = await query(
    `SELECT question_key, option_key, pattern, weight, position
       FROM sos_answers WHERE submission_id = $1 ORDER BY position`,
    [id],
  );
  return {
    ...mapSubmission(subRes.rows[0]),
    answers: ansRes.rows.map((a) => ({
      questionKey: a.question_key,
      optionKey: a.option_key,
      pattern: a.pattern,
      weight: Number(a.weight),
      position: a.position,
    })),
  };
}

async function deleteSubmission(id) {
  const res = await query('DELETE FROM sos_submissions WHERE id = $1 RETURNING id', [id]);
  return res.rows.length > 0;
}

async function clearAllSubmissions() {
  const res = await query('DELETE FROM sos_submissions RETURNING id');
  return res.rows.length;
}

/** Rows for aggregation.buildSummary — anonymous by construction. */
async function getSummaryRows() {
  const [subs, patterns, options] = await Promise.all([
    query('SELECT department, dispatch_team_id, dispatch_team_name, primary_pattern FROM sos_submissions'),
    query(
      `SELECT s.department AS submission_department, a.pattern, SUM(a.weight)::float AS count
         FROM sos_answers a JOIN sos_submissions s ON s.id = a.submission_id
        GROUP BY s.department, a.pattern`,
    ),
    query('SELECT question_key, option_key, COUNT(*)::int AS count FROM sos_answers GROUP BY question_key, option_key'),
  ]);
  return {
    submissions: subs.rows.map((r) => ({
      department: r.department,
      dispatchTeamId: r.dispatch_team_id,
      dispatchTeamName: r.dispatch_team_name,
      primaryPattern: r.primary_pattern,
    })),
    answerPatternRows: patterns.rows.map((r) => ({
      submissionDepartment: r.submission_department,
      pattern: r.pattern,
      count: Number(r.count),
    })),
    questionOptionRows: options.rows.map((r) => ({
      questionKey: r.question_key,
      optionKey: r.option_key,
      count: Number(r.count),
    })),
  };
}

/** Completion counts for the admin status card. */
async function getCompletionStats() {
  const [total, byDept, byTeam, last] = await Promise.all([
    query('SELECT COUNT(*)::int AS n FROM sos_submissions'),
    query('SELECT department, COUNT(*)::int AS n FROM sos_submissions GROUP BY department'),
    query(
      `SELECT dispatch_team_name, COUNT(*)::int AS n FROM sos_submissions
        WHERE dispatch_team_name IS NOT NULL GROUP BY dispatch_team_name ORDER BY dispatch_team_name`,
    ),
    query('SELECT MAX(created_at) AS at FROM sos_submissions'),
  ]);
  const byDepartment = {};
  for (const row of byDept.rows) byDepartment[row.department] = row.n;
  return {
    total: total.rows[0].n,
    byDepartment,
    byTeam: byTeam.rows.map((r) => ({ teamName: r.dispatch_team_name, count: r.n })),
    lastSubmissionAt: last.rows[0].at,
  };
}

module.exports = {
  getSettings,
  setOpen,
  findDuplicate,
  createSubmission,
  getSubmissionByToken,
  listSubmissions,
  getSubmissionDetail,
  deleteSubmission,
  clearAllSubmissions,
  getSummaryRows,
  getCompletionStats,
};
