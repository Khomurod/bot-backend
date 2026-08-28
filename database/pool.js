/**
 * Shared PostgreSQL pool + query helper.
 *
 * MOCKED for AI Studio
 */
const { Pool } = require('pg');

const pool = {
  query: async () => ({ rows: [] }),
  connect: async () => ({
    query: async () => ({ rows: [] }),
    release: () => {},
  }),
  on: () => {},
  end: async () => {},
};

async function query(text, params) {
  return { rows: [], rowCount: 0 };
}

async function ping() {
  return true;
}

module.exports = { pool, query, ping };
