/**
 * Shared harness for the Trailer Department PostgreSQL integration tests.
 *
 * database/schema.sql runs on EVERY boot, so its DDL must be additive and
 * idempotent. This applies the REAL, COMPLETE schema.sql into a throwaway
 * PostgreSQL schema, so tests exercise the actual production migration and the
 * actual tables — no hand-written stubs to drift out of sync with reality.
 *
 * An earlier version stubbed the few tables defined before the department
 * banner. Every stub was another chance to be wrong about production (a missing
 * column, a missed constraint), and each one hid real bugs until a test happened
 * to reach past it. Applying the whole file costs a second and removes the guess.
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

const SECTION_MARKER = '-- TRAILER DEPARTMENT: RENTAL + ASSET MANAGEMENT';
const DATABASE_DIR = path.resolve(__dirname, '../../database');
const POOL_PATH = require.resolve('../../database/pool');

/**
 * The department slice of schema.sql: everything after the section banner to
 * end of file. Read fresh each call so a test never sees a stale copy.
 */
function departmentSchemaSection() {
  const schema = fs.readFileSync(require.resolve('../../database/schema.sql'), 'utf8');
  const parts = schema.split(SECTION_MARKER);
  if (parts.length < 2) {
    throw new Error(`schema.sql no longer contains the "${SECTION_MARKER}" banner. The PG harness slices on it.`);
  }
  return parts[1];
}

/** The complete schema.sql, exactly as production runs it on every boot. */
function fullSchema() {
  return fs.readFileSync(require.resolve('../../database/schema.sql'), 'utf8');
}

/** node:test skip value: false to run, else the reason string. */
function skipWithoutPg() {
  return process.env.TEST_DATABASE_URL ? false : 'set TEST_DATABASE_URL';
}

/**
 * Stand up an isolated schema with the department migration applied.
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
async function createTrailerPgHarness(t, options = {}) {
  const { extraDdl = '', applySchema = true } = options;
  const schema = `td_${crypto.randomBytes(6).toString('hex')}`;
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
  async function applyDepartmentSchema() {
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
   * first — otherwise a module cached from an earlier load (trailerAudit, say,
   * which trailerRentals pulls in) would still hold the production pool and
   * quietly write to the real database.
   *
   *
   * @param {string[]} moduleNames e.g. ['trailerRentals']
   * @returns {object} map of moduleName -> loaded module
   */
  function loadDataLayer(moduleNames) {
    const scopedPool = quiet(new Pool({ connectionString: databaseUrl.toString(), max: 4 }));
    scopedPools.push(scopedPool);

    // RECURSIVE on purpose: the data layer has nested packages
    // (database/trailerMasterList/*). Purging only the top level would leave
    // those bound to an earlier load's pool — which, once this harness's
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

  /**
   * Load services/trailerStorage bound to the throwaway database, with the
   * Supabase config under the test's control.
   *
   * `supabaseConfigured` decides which backend the package selects — the whole
   * point being that an UNCONFIGURED deployment must still store files.
   *
   * @param {object} [options]
   * @param {boolean} [options.supabaseConfigured=false]
   * @returns {object} the storage package
   */
  function loadStorage(options = {}) {
    const { supabaseConfigured = false } = options;
    const configPath = require.resolve('../../config/config');
    const realConfig = require('../../config/config');
    const storageDir = path.resolve(__dirname, '../../services/trailerStorage');
    const facadePath = require.resolve('../../services/trailerStorageService');

    const scopedPool = quiet(new Pool({ connectionString: databaseUrl.toString(), max: 4 }));
    scopedPools.push(scopedPool);

    const purge = () => {
      for (const file of fs.readdirSync(storageDir)) {
        if (file.endsWith('.js')) delete require.cache[path.join(storageDir, file)];
      }
      delete require.cache[facadePath];
      delete require.cache[POOL_PATH];
      delete require.cache[configPath];
    };

    purge();
    require.cache[POOL_PATH] = {
      id: POOL_PATH,
      filename: POOL_PATH,
      loaded: true,
      exports: { pool: scopedPool, query: (t, v) => scopedPool.query(t, v), ping: async () => true },
    };
    require.cache[configPath] = {
      id: configPath,
      filename: configPath,
      loaded: true,
      exports: {
        ...realConfig,
        supabaseUrl: supabaseConfigured ? 'https://example.supabase.co' : null,
        supabaseServiceRoleKey: supabaseConfigured ? 'service-role-key' : null,
        trailerStorageBucket: 'trailer-private',
        jwtSecret: 'test-signing-secret',
        renderExternalUrl: 'https://example.test',
      },
    };
    try {
      return require('../../services/trailerStorage');
    } finally {
      purge();
    }
  }

  if (applySchema) await applyDepartmentSchema();

  return { pool, schema, connect, query, applyDepartmentSchema, loadDataLayer, loadStorage };
}

module.exports = {
  createTrailerPgHarness,
  departmentSchemaSection,
  skipWithoutPg,
  SECTION_MARKER,
};
