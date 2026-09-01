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
 * Query helper with logging
 */
/**
 * Query helper with logging
 */
async function query(text, params) {
  try {
    const result = await pool.query(text, params);
    return result;
  } catch (err) {
    console.error('[DB] Query error:', err.message, '\nQuery:', text);
    throw err;
  }
}

// Simple DB liveness probe used by /api/health.
async function ping() {
  const res = await query('SELECT 1 AS ok');
  return res.rows[0]?.ok === 1;
}

module.exports = { pool, query, ping };
