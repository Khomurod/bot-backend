/**
 * Shared harness for the Trailer Department PostgreSQL integration tests.
 *
 * database/schema.sql runs on EVERY boot, so the department's DDL must be
 * additive and idempotent. These tests prove that against a real PostgreSQL by
 * applying only the "TRAILER DEPARTMENT" slice of schema.sql into a throwaway
 * schema, which keeps each test isolated and cheap.
 *
 * The slice depends on three tables defined EARLIER in schema.sql (admins,
 * trailers, trailer_events) plus trailer_settings; those are stubbed here with
 * just the columns the slice needs, because the slice ALTERs them to add the
 * rest. Everything else (roles, permissions, rentals, invoices, …) is created
 * by the slice itself and must never be stubbed — stubbing it would hide a
 * broken migration.
 *
 * Requires TEST_DATABASE_URL; call skipWithoutPg() in the test's skip option.
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

/** node:test skip value: false to run, else the reason string. */
function skipWithoutPg() {
  return process.env.TEST_DATABASE_URL ? false : 'set TEST_DATABASE_URL';
}

/**
 * Tables the department slice expects to already exist. Only the columns the
 * slice actually reads/ALTERs are declared — the slice adds the rest.
 */
const PREREQUISITE_DDL = `
  CREATE TABLE admins (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE trailers (
    id SERIAL PRIMARY KEY,
    unit_number TEXT UNIQUE NOT NULL,
    make TEXT NULL,
    model TEXT NULL,
    mc_number TEXT NULL,
    plate_number TEXT NULL,
    type TEXT NULL,
    vin TEXT NULL,
    year TEXT NULL,
    ownership_status TEXT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    needs_review BOOLEAN NOT NULL DEFAULT FALSE,
    source TEXT NOT NULL DEFAULT 'admin_manual',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE trailer_events (
    id BIGSERIAL PRIMARY KEY
  );
  CREATE TABLE trailer_settings (
    id INTEGER PRIMARY KEY,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  INSERT INTO trailer_settings (id) VALUES (1);
  -- Master-list snapshot imports reuse the screenshot-import staging tables, so
  -- the slice both ALTERs them and takes foreign keys against them.
  CREATE TABLE trailer_import_batches (
    id SERIAL PRIMARY KEY,
    uploaded_by TEXT NULL,
    file_name TEXT NULL,
    status TEXT NOT NULL DEFAULT 'parsed'
      CONSTRAINT trailer_import_batches_status_check CHECK (status IN ('parsed', 'committed', 'failed')),
    parsed_count INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    raw_ai_result JSONB NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE trailer_import_rows (
    id SERIAL PRIMARY KEY,
    batch_id INTEGER NOT NULL REFERENCES trailer_import_batches(id) ON DELETE CASCADE,
    unit_number TEXT NULL,
    make TEXT NULL,
    model TEXT NULL,
    mc_number TEXT NULL,
    plate_number TEXT NULL,
    type TEXT NULL,
    vin TEXT NULL,
    year TEXT NULL,
    ownership_status TEXT NULL,
    confidence SMALLINT NULL,
    needs_review BOOLEAN NOT NULL DEFAULT FALSE,
    raw_row JSONB NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

/**
 * Stand up an isolated schema with the department migration applied.
 *
 * Registers its own cleanup via t.after, so a test never leaks a schema or a
 * pool even when it fails.
 *
 * @param {import('node:test').TestContext} t
 * @param {object} [options]
 * @param {string} [options.extraDdl]   DDL appended to the prerequisites (before the slice).
 * @param {boolean} [options.applySchema=true]  Apply the department slice on setup.
 * @returns {Promise<object>} harness
 */
async function createTrailerPgHarness(t, options = {}) {
  const { extraDdl = '', applySchema = true } = options;
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 });
  const schema = `td_${crypto.randomBytes(6).toString('hex')}`;
  /** Extra pools handed to loadDataLayer(); drained before the schema drops. */
  const scopedPools = [];

  t.after(async () => {
    // Data-layer pools hold connections into the schema — drain them first or
    // the DROP blocks behind them.
    await Promise.allSettled(scopedPools.map((p) => p.end()));
    try {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await pool.end();
    }
  });

  const setup = await pool.connect();
  try {
    await setup.query(`CREATE SCHEMA ${schema}`);
    await setup.query(`SET search_path TO ${schema},public`);
    await setup.query(PREREQUISITE_DDL);
    if (extraDdl) await setup.query(extraDdl);
  } finally {
    setup.release();
  }

  /** A pooled client already scoped to the throwaway schema. Caller releases. */
  async function connect() {
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${schema},public`);
      return client;
    } catch (error) {
      client.release();
      throw error;
    }
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
   * Apply the department slice. Call repeatedly to prove idempotency — that is
   * exactly what production does on every boot.
   */
  async function applyDepartmentSchema() {
    const client = await connect();
    try {
      await client.query(departmentSchemaSection());
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
   * search_path is pinned on the connection itself rather than via SET, so
   * every pooled connection lands in the throwaway schema without each caller
   * having to remember.
   *
   * @param {string[]} moduleNames e.g. ['trailerRentals']
   * @returns {object} map of moduleName -> loaded module
   */
  function loadDataLayer(moduleNames) {
    const scopedPool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 4,
      options: `-c search_path=${schema},public`,
    });
    scopedPools.push(scopedPool);

    const purge = () => {
      for (const file of fs.readdirSync(DATABASE_DIR)) {
        if (file.endsWith('.js')) delete require.cache[path.join(DATABASE_DIR, file)];
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

  if (applySchema) await applyDepartmentSchema();

  return { pool, schema, connect, query, applyDepartmentSchema, loadDataLayer };
}

module.exports = {
  createTrailerPgHarness,
  departmentSchemaSection,
  skipWithoutPg,
  SECTION_MARKER,
};
