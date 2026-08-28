const { Pool } = require('pg');
const config = require('../config/config');

let pool;
let isMock = false;

// If we are in the real app (not tests) and there is no DB configured, use a fast mock.
// But we MUST use `new Pool()` so the tests can intercept it using require.cache on 'pg'.
if (!config.databaseUrl && process.env.NODE_ENV !== 'test') {
  isMock = true;
  pool = {
    query: async () => ({ rows: [] }),
    connect: async () => ({
      query: async () => ({ rows: [] }),
      release: () => {},
    }),
    on: () => {},
    end: async () => {},
  };
} else {
  pool = new Pool({
    connectionString: config.databaseUrl,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  });

  pool.on('error', (err) => {
    console.error('[DB] Unexpected error on idle client', err.message);
  });
}

async function query(text, params) {
  if (isMock) {
    return { rows: [], rowCount: 0 };
  }
  return pool.query(text, params);
}

async function ping() {
  if (isMock) return true;
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (err) {
    return false;
  }
}

module.exports = { pool, query, ping };
