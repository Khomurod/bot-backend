/**
 * SOS assessment — data access layer (tables from migrations 0003 + 0004).
 *
 * Deliberately separate from the Telegram driver-feedback survey tables
 * (questions/options/responses). Not spread into database/db.js — require this
 * module directly. Submissions are written in one transaction together with
 * their 10 answer snapshots; results are stored at submit time and never
 * recomputed, so a stored result can never change.
 *
 * REAL/TEST ISOLATION (permanent invariant): every submission row carries
 * `is_test`; FALSE = real production data (the pre-0004 default, so all
 * historical rows are real). EVERY query in this module that touches
 * submissions is scoped by mode AT THE SQL LEVEL — summaries, duplicate
 * detection, result-token lookup, completion stats, list, and clear. Mode
 * flags are normalized with `=== true`, so an accidentally-undefined flag
 * degrades to REAL-mode reads and can never widen a delete: `clearSubmissions`
 * requires an explicit boolean and refuses anything else. The test pages can
 * therefore never read or destroy real records even if a frontend or route
 * bug passes the wrong thing.
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
    isTest: row.is_test === true,
    createdAt: row.created_at,
    ...(row.duplicate_count !== undefined ? { duplicateCount: Number(row.duplicate_count) } : {}),
  };
}

/** Both switches in one read: `is_open` (real) and `test_is_open` (test). */
async function getSettings() {
  const res = await query('SELECT is_open, test_is_open, updated_at FROM sos_settings WHERE id = 1');
  const row = res.rows[0];
  return {
    isOpen: row ? row.is_open === true : false,
    testIsOpen: row ? row.test_is_open === true : false,
    updatedAt: row ? row.updated_at : null,
  };
}

/** Toggle exactly one mode's switch; the other mode is untouched. */
async function setOpen(isOpen, isTest) {
  const column = isTest === true ? 'test_is_open' : 'is_open';
  await query(
    `UPDATE sos_settings SET ${column} = $1, updated_at = NOW() WHERE id = 1`,
    [isOpen === true],
  );
  return getSettings();
}

/** Latest same-mode submission with the same normalized name + department. */
async function findDuplicate(nameNormalized, department, isTest) {
  const res = await query(
    `SELECT id, created_at FROM sos_submissions
      WHERE name_normalized = $1 AND department = $2 AND is_test = $3
      ORDER BY created_at DESC LIMIT 1`,
    [nameNormalized, department, isTest === true],
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
          result_token, duplicate_confirmed, client_ip, is_test)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
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
        input.isTest === true,
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

/**
 * Result re-view via capability token, scoped to its mode: a real token is
 * invisible to the test route and vice versa. Excludes name/ip on purpose.
 */
async function getSubmissionByToken(resultToken, isTest) {
  const res = await query(
    `SELECT language, department, content_version, pattern_scores,
            primary_pattern, secondary_pattern, created_at
       FROM sos_submissions WHERE result_token = $1 AND is_test = $2`,
    [resultToken, isTest === true],
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

/**
 * Admin list. `mode` is explicit: 'real' | 'test' | 'all' (combined view the
 * admin selects deliberately). duplicateCount never counts across modes.
 */
async function listSubmissions({ department, dispatchTeamName, pattern, search, mode = 'real', limit = 500 } = {}) {
  const where = [];
  const values = [];
  const add = (sqlForIndex, value) => { values.push(value); where.push(sqlForIndex(`$${values.length}`)); };
  if (mode !== 'all') add((i) => `is_test = ${i}`, mode === 'test');
  if (department) add((i) => `department = ${i}`, department);
  // Teams are identified by their exact snapshotted NAME, not by the legacy
  // dispatch_team_id foreign key — see services/sosAssessment/dispatchTeams.js.
  if (dispatchTeamName) add((i) => `dispatch_team_name = ${i}`, dispatchTeamName);
  if (pattern) add((i) => `(primary_pattern = ${i} OR secondary_pattern = ${i})`, pattern);
  if (search) add((i) => `full_name ILIKE ${i}`, `%${search}%`);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  values.push(Math.min(Number(limit) || 500, 2000));
  const res = await query(
    `SELECT *, COUNT(*) OVER (PARTITION BY name_normalized, department, is_test) AS duplicate_count
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

/**
 * Clear ONE mode's submissions. The mode is a REQUIRED boolean — anything
 * else throws, so no caller can ever wipe both modes (or the wrong mode) by
 * omitting a flag. Cascade removes the mode's answers with its submissions.
 */
async function clearSubmissions(isTest) {
  if (typeof isTest !== 'boolean') {
    throw new Error('clearSubmissions requires an explicit boolean mode');
  }
  const res = await query('DELETE FROM sos_submissions WHERE is_test = $1 RETURNING id', [isTest]);
  return res.rows.length;
}

/**
 * Rows for aggregation.buildSummary — anonymous by construction, one mode only.
 *
 * The public /answers summary is COMPANY-WIDE, so this reads exactly one column:
 * each respondent's primary pattern. Department, dispatch team, per-answer
 * patterns and question/option distributions are deliberately NOT selected — the
 * public payload has no place to put them, and data that is never read cannot
 * leak. Those columns are still stored and are served by the admin API.
 */
async function getSummaryRows(isTest) {
  const subs = await query(
    'SELECT primary_pattern FROM sos_submissions WHERE is_test = $1',
    [isTest === true],
  );
  return {
    submissions: subs.rows.map((r) => ({ primaryPattern: r.primary_pattern })),
  };
}

/** Completion counts for the admin status card, one mode only. */
async function getCompletionStats(isTest) {
  const mode = isTest === true;
  const [total, byDept, byTeam, last] = await Promise.all([
    query('SELECT COUNT(*)::int AS n FROM sos_submissions WHERE is_test = $1', [mode]),
    query('SELECT department, COUNT(*)::int AS n FROM sos_submissions WHERE is_test = $1 GROUP BY department', [mode]),
    query(
      `SELECT dispatch_team_name, COUNT(*)::int AS n FROM sos_submissions
        WHERE dispatch_team_name IS NOT NULL AND is_test = $1
        GROUP BY dispatch_team_name ORDER BY dispatch_team_name`,
      [mode],
    ),
    query('SELECT MAX(created_at) AS at FROM sos_submissions WHERE is_test = $1', [mode]),
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
  clearSubmissions,
  getSummaryRows,
  getCompletionStats,
};
