/**
 * The repository's PostgreSQL integration harness.
 *
 * database/schema.sql runs on EVERY boot, so its DDL must be additive and
 * idempotent. This applies the REAL, COMPLETE schema.sql into a throwaway
 * PostgreSQL database, so tests exercise the actual production migration and
 * the actual tables — no hand-written stubs to drift out of sync with reality.
 *
 * An earlier version stubbed a subset of tables. Every stub was another chance
 * to be wrong about production (a missing column, a missed constraint), and
 * each one hid real bugs until a test happened to reach past it. Applying the
 * whole file costs a second and removes the guess.
 *
 * Isolation is per-test via a throwaway DATABASE, each using its own `public`
 * schema — exactly the shape production runs in. That matters: schema.sql is
 * full of guards that check pg_constraint / information_schema by NAME without
 * a schema filter. With several schemas in one database those guards see each
 * other's constraints and misfire. One database per test sidesteps all of it and
 * keeps the tests faithful to production.
 *
 * Requires TEST_DATABASE_URL; call skipWithoutPg() in the test's skip option.
 * The database must be UTF8 — schema.sql contains box-drawing characters.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const DATABASE_DIR = path.resolve(__dirname, '../../database');
const POOL_PATH = require.resolve('../../database/pool');

/** The complete schema.sql, exactly as production runs it on every boot. */
function fullSchema() {
  return fs.readFileSync(require.resolve('../../database/schema.sql'), 'utf8');
}

/** node:test skip value: false to run, else the reason string. */
function skipWithoutPg() {
  return process.env.TEST_DATABASE_URL ? false : 'set TEST_DATABASE_URL';
}

/**
 * Stand up an isolated throwaway database with schema.sql applied.
 *
 * Registers its own cleanup via t.after, so a test never leaks a schema or a
 * pool even when it fails.
 *
 * @param {import('node:test').TestContext} t
 * @param {object} [options]
 * @param {string} [options.extraDdl]  DDL applied after the schema.
 * @param {boolean} [options.applySchema=true]  Apply schema.sql on setup.
 * @returns {Promise<object>} harness
 */
async function createPgHarness(t, options = {}) {
  const { extraDdl = '', applySchema = true } = options;
  const schema = `pgh_${crypto.randomBytes(6).toString('hex')}`;
  const adminUrl = process.env.TEST_DATABASE_URL;
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${schema}`;

  // An idle pooled client terminated server-side (a DROP DATABASE … FORCE from
  // teardown racing a straggler) emits 'error' on the pool; with no listener
  // that becomes an uncaughtException attributed to whatever test happens to be
  // running. Swallow it — every query path still surfaces its own errors.
  const quiet = (p) => { p.on('error', () => {}); return p; };

  // A separate connection to the maintenance database: CREATE/DROP DATABASE
  // cannot run from inside the database being created or dropped.
  const admin = quiet(new Pool({ connectionString: adminUrl, max: 2 }));
  // template0 + UTF8: schema.sql contains box-drawing characters in comments,
  // which a WIN1252 cluster default cannot store.
  await admin.query(`CREATE DATABASE ${schema} WITH ENCODING 'UTF8' TEMPLATE template0`);

  const pool = quiet(new Pool({ connectionString: databaseUrl.toString(), max: 4 }));
  /** Extra pools handed to loadDataLayer(); drained before the database drops. */
  const scopedPools = [];

  t.after(async () => {
    // Every connection must be gone before DROP DATABASE, hence FORCE as a
    // backstop for anything a failing test left open.
    await Promise.allSettled(scopedPools.map((p) => p.end()));
    await pool.end().catch(() => {});
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${schema} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  });

  /** A pooled client on the throwaway database. Caller releases. */
  async function connect() {
    return pool.connect();
  }

  /** Run one statement on a scoped connection. */
  async function query(text, values) {
    const client = await connect();
    try {
      return await client.query(text, values);
    } finally {
      client.release();
    }
  }

  /**
   * Apply the COMPLETE schema.sql. Call repeatedly to prove idempotency — that
   * is exactly what production does on every boot.
   */
  async function applySchemaSql() {
    const client = await connect();
    try {
      await client.query(fullSchema());
      if (extraDdl) await client.query(extraDdl);
    } finally {
      client.release();
    }
  }

  /**
   * Load real database/*.js modules bound to the throwaway schema.
   *
   * The data layer destructures `{ pool, query }` from database/pool at require
   * time, so the stub is installed and the whole database/ directory purged
   * first — otherwise a module cached from an earlier load would still hold the
   * production pool and quietly write to the real database.
   *
   * @param {string[]} moduleNames e.g. ['rbac']
   * @returns {object} map of moduleName -> loaded module
   */
  function loadDataLayer(moduleNames) {
    const scopedPool = quiet(new Pool({ connectionString: databaseUrl.toString(), max: 4 }));
    scopedPools.push(scopedPool);

    // RECURSIVE on purpose: the data layer has nested packages
    // (database/homeTime/*, database/routeControl/*, …). Purging only the top
    // level would leave those bound to an earlier load's pool — which, once this harness's
    // t.after has ended it, surfaces as "Cannot use a pool after calling end".
    const purge = (dir = DATABASE_DIR) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) purge(full);
        else if (entry.name.endsWith('.js')) delete require.cache[full];
      }
    };

    purge();
    require.cache[POOL_PATH] = {
      id: POOL_PATH,
      filename: POOL_PATH,
      loaded: true,
      exports: {
        pool: scopedPool,
        query: (text, values) => scopedPool.query(text, values),
        ping: async () => true,
      },
    };
    try {
      const loaded = {};
      for (const name of moduleNames) loaded[name] = require(path.join(DATABASE_DIR, name));
      return loaded;
    } finally {
      // Drop the stub and every module that captured it, so an unrelated later
      // require in this process gets the real pool back.
      delete require.cache[POOL_PATH];
      purge();
    }
  }

  if (applySchema) await applySchemaSql();

  return { pool, schema, connect, query, applySchemaSql, loadDataLayer };
}

/**
 * Every forward migration, concatenated in version order — what a real boot
 * applies on top of the baseline.
 *
 * Why a test wants this rather than just the one migration it is about: these
 * suites exercise the CURRENT data layer against the schema, and the data layer
 * only knows the newest shape. A test pinned to migration 0008 alone started
 * failing the moment 0011 added a column that `insertFacebookLeadSmsMirror`
 * writes — the test was right about 0008 and wrong about the world. Pass this
 * as `extraDdl` when a test writes THROUGH the data layer; pass a single
 * migration when the test is about that migration's own DDL.
 *
 * @param {(name: string) => boolean} [filter]  e.g. up-to-a-version
 * @returns {string}
 */
function allMigrationsSql(filter = () => true) {
  const dir = path.join(__dirname, '..', '..', 'database', 'migrations');
  return fs.readdirSync(dir)
    .filter((name) => /^\d{4,}_[a-z0-9_]+\.sql$/.test(name))
    .filter(filter)
    .sort()
    .map((name) => fs.readFileSync(path.join(dir, name), 'utf8'))
    .join('\n');
}

module.exports = {
  createPgHarness,
  skipWithoutPg,
  allMigrationsSql,
};
