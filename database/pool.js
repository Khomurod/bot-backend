/**
 * Shared PostgreSQL pool + query helper.
 *
 * The single place the pg Pool is created. database/db.js re-exports
 * pool/query/ping so the legacy `require('./db')` seam keeps working; the
 * per-feature database modules require THIS file directly (never db.js) so
 * the module graph stays acyclic.
 */
const { Pool } = require('pg');
const config = require('../config/config');
const transferMeter = require('./transferMeter');
const { classifyDatabaseError } = require('../lib/database/failureClassification');

const pool = new Pool({
  connectionString: config.databaseUrl,
  // Keep the pool modest: this app runs on a memory-constrained single
  // instance and most database providers' free tiers cap total connections.
  // Lowered to 5 to free memory headroom on the 512MB free Render instance.
  max: Number.parseInt(process.env.PG_POOL_MAX || '5', 10),
  idleTimeoutMillis: Number.parseInt(process.env.PG_IDLE_TIMEOUT_MS || '30000', 10),
  // Free-tier databases can be slow to open a fresh connection (cold start +
  // SSL handshake), so allow a generous window. Set 0 to wait indefinitely.
  connectionTimeoutMillis: Number.parseInt(process.env.PG_CONNECTION_TIMEOUT_MS || '30000', 10),
  ssl: config.databaseUrl && config.databaseUrl.includes('sslmode=require')
    ? { rejectUnauthorized: false }
    : (config.databaseUrl && (config.databaseUrl.includes('supabase') || config.databaseUrl.includes('neon'))
      ? { rejectUnauthorized: false }
      : false),
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

/**
 * The one place every database read and write passes through.
 *
 * Two things happen here besides the query itself, and both exist because of
 * the same incident — a hosted database at 4.222 GB of a 5 GB monthly transfer
 * allowance, with the application unable to tell an outage from an empty table:
 *
 *   1. USAGE ACCOUNTING. Each result feeds database/transferMeter.js, which
 *      estimates the bytes read this month so the panel can warn at 80/90/95%
 *      instead of discovering the ceiling by hitting it. Sampled, not measured
 *      on every row — see that module.
 *
 *   2. FAILURE CLASSIFICATION. An infrastructure failure gets a `dbFailure`
 *      tag ({ code, status, message }) attached, so a route can answer "the
 *      database could not be reached" or "a usage limit was reached" instead of
 *      a bare 500 — and never an empty list that reads as "no data".
 *
 * NEITHER MAY BREAK A QUERY. The accounting is wrapped so a bug in it cannot
 * fail a request, and the original error object is rethrown UNCHANGED apart
 * from the added tag: `err.code` stays the SQLSTATE that callers already check
 * (a '23505' unique-violation path must keep working), and the message is not
 * rewritten.
 */
async function query(text, params) {
  try {
    const result = await pool.query(text, params);
    try {
      transferMeter.recordQuery(result);
    } catch (meterError) {
      // Accounting is best-effort; the query already succeeded.
    }
    return result;
  } catch (err) {
    console.error('[DB] Query error:', err.message, '\nQuery:', text);
    const failure = classifyDatabaseError(err);
    if (failure && !err.dbFailure) {
      Object.defineProperty(err, 'dbFailure', {
        value: failure, enumerable: false, configurable: true, writable: true,
      });
    }
    throw err;
  }
}

// Simple DB liveness probe used by /api/health.
async function ping() {
  const res = await query('SELECT 1 AS ok');
  return res.rows[0]?.ok === 1;
}

module.exports = { pool, query, ping };
