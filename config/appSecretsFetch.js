'use strict';

/**
 * Read the app secrets for ONE service and print them as JSON on stdout.
 *
 *   node config/appSecretsFetch.js bot
 *
 * Run by config/appSecretsBoot.js as a short-lived child process, because the
 * secrets must be in process.env BEFORE the first `require` of config/config.js
 * (which reads process.env when it loads) and a database read is asynchronous.
 * Nothing else should run it.
 *
 * It reads with its own single `pg` client — not database/pool.js, which would
 * load config/config.js — opens each value with INTEGRATION_SECRET_KEY ONLY
 * (never the key derived from DATABASE_URL), and exits.
 *
 * stdout carries exactly one JSON line:
 *   {"status":"loaded","version":12,"values":{...}}
 *   {"status":"skipped","reason":"..."}       nothing to apply, and that is fine
 *   {"status":"failed","reason":"..."}        could not read what is there
 * A reason never contains a value. stderr is not used for data.
 */
const { Client } = require('pg');
const sharedCrypto = require('../lib/security/sharedIntegrationCrypto');
const { sslForUrl } = require('../lib/database/sslForUrl');
const { isTarget, scopesReadBy } = require('../lib/appSecrets/rules');

const CONNECT_TIMEOUT_MS = 15_000;
const QUERY_TIMEOUT_MS = 10_000;

function emit(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function fetchAppSecrets(target, env = process.env, ClientImpl = Client) {
  if (!isTarget(target)) return { status: 'failed', reason: `unknown service "${target}"` };
  const url = String(env.DATABASE_URL || '').trim();
  const key = String(env.INTEGRATION_SECRET_KEY || '').trim();
  if (!url) return { status: 'skipped', reason: 'DATABASE_URL is not set' };
  if (!key) return { status: 'skipped', reason: 'INTEGRATION_SECRET_KEY is not set' };

  const pinnedRaw = String(env.APP_SECRETS_VERSION || '').trim();
  if (pinnedRaw && !/^\d+$/.test(pinnedRaw)) {
    return { status: 'failed', reason: 'APP_SECRETS_VERSION must be a version number' };
  }
  // Only the explicit key: a value stored here must not open with the database password.
  const keyEnv = { INTEGRATION_SECRET_KEY: key };

  const client = new ClientImpl({
    connectionString: url,
    ssl: sslForUrl(url),
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
  });
  try {
    await client.connect();
    let version;
    try {
      const res = await client.query(
        `SELECT id, key_fingerprint FROM app_secret_versions
          WHERE ($1::bigint IS NULL OR id = $1::bigint)
          ORDER BY id DESC LIMIT 1`,
        [pinnedRaw || null],
      );
      version = res.rows[0];
    } catch (err) {
      if (err && err.code === '42P01') return { status: 'skipped', reason: 'the secrets table does not exist yet' };
      throw err;
    }
    if (!version) {
      return pinnedRaw
        ? { status: 'failed', reason: `version ${pinnedRaw} does not exist` }
        : { status: 'skipped', reason: 'nothing is stored yet' };
    }
    if (version.key_fingerprint !== sharedCrypto.fingerprint(keyEnv)) {
      return {
        status: 'failed',
        reason: `version ${version.id} was stored under a different INTEGRATION_SECRET_KEY`,
      };
    }

    const scopes = scopesReadBy(target);
    const rows = (await client.query(
      'SELECT scope, name, ciphertext FROM app_secret_values WHERE version_id = $1 AND scope = ANY($2::text[])',
      [version.id, scopes],
    )).rows;

    const values = {};
    const unreadable = [];
    for (const scope of scopes) {
      for (const row of rows) {
        if (row.scope !== scope) continue;
        try {
          values[row.name] = sharedCrypto.decryptShared(row.ciphertext, keyEnv);
        } catch {
          unreadable.push(row.name);
        }
      }
    }
    if (unreadable.length) {
      return { status: 'failed', reason: `could not open ${unreadable.join(', ')} in version ${version.id}` };
    }
    return { status: 'loaded', version: Number(version.id), values };
  } catch (err) {
    // The message of a pg error never holds a value of ours, but the URL could
    // appear in a connection error: keep only the code and a generic line.
    return { status: 'failed', reason: `database read failed${err && err.code ? ` (${err.code})` : ''}` };
  } finally {
    await client.end().catch(() => {});
  }
}

if (require.main === module) {
  fetchAppSecrets(process.argv[2])
    .then(emit)
    .catch(() => emit({ status: 'failed', reason: 'unexpected error' }));
}

module.exports = { fetchAppSecrets };
