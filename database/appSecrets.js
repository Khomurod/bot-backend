'use strict';

/**
 * Storage of the app secrets — the versioned, encrypted table behind
 * Settings → System → Secrets (migration 0091, docs/architecture/app-secrets.md).
 *
 * This module only moves rows. It never encrypts, decrypts or checks anything
 * (services/appSecrets/secretsService.js does), and it never logs a row: a
 * row's ciphertext is still a secret's ciphertext.
 *
 * A version is written whole, in one transaction, and never changed after:
 * the latest version is the one in use.
 */
const { pool, query } = require('./pool');

/** The newest version's header, or null when nothing has been stored. */
async function getLatestVersion(run = query) {
  const res = await run(
    `SELECT id, created_at, created_by, note, key_fingerprint, restored_from
       FROM app_secret_versions ORDER BY id DESC LIMIT 1`,
  );
  return res.rows[0] || null;
}

async function getVersion(id, run = query) {
  const res = await run(
    `SELECT id, created_at, created_by, note, key_fingerprint, restored_from
       FROM app_secret_versions WHERE id = $1`,
    [id],
  );
  return res.rows[0] || null;
}

/** Every row of one version: {scope, name, ciphertext, last4}. */
async function getVersionValues(versionId, run = query) {
  const res = await run(
    `SELECT scope, name, ciphertext, last4 FROM app_secret_values
      WHERE version_id = $1 ORDER BY name, scope`,
    [versionId],
  );
  return res.rows;
}

/** Recent versions, newest first, with how many values each holds. */
async function listVersions(limit = 20, run = query) {
  const res = await run(
    `SELECT v.id, v.created_at, v.created_by, v.note, v.key_fingerprint, v.restored_from,
            COUNT(s.name)::int AS value_count
       FROM app_secret_versions v
       LEFT JOIN app_secret_values s ON s.version_id = v.id
      GROUP BY v.id
      ORDER BY v.id DESC
      LIMIT $1`,
    [limit],
  );
  return res.rows;
}

/**
 * Write a new version and all its rows atomically.
 *
 * @param {object} input
 * @param {string|null} input.createdBy
 * @param {string|null} input.note
 * @param {string} input.keyFingerprint
 * @param {number|null} [input.restoredFrom]
 * @param {{scope: string, name: string, ciphertext: string, last4: string}[]} input.values
 * @returns {Promise<number>} the new version id
 */
async function insertVersion({ createdBy, note, keyFingerprint, restoredFrom = null, values }, db = pool) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const head = await client.query(
      `INSERT INTO app_secret_versions (created_by, note, key_fingerprint, restored_from)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [createdBy, note, keyFingerprint, restoredFrom],
    );
    const versionId = head.rows[0].id;
    for (const v of values) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `INSERT INTO app_secret_values (version_id, scope, name, ciphertext, last4)
         VALUES ($1, $2, $3, $4, $5)`,
        [versionId, v.scope, v.name, v.ciphertext, v.last4 || ''],
      );
    }
    await client.query('COMMIT');
    return Number(versionId);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  getLatestVersion,
  getVersion,
  getVersionValues,
  listVersions,
  insertVersion,
};
