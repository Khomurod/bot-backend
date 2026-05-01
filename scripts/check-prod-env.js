// scripts/check-prod-env.js
// This script validates that all required environment variables are set
// and attempts to connect to the PostgreSQL database.

require('dotenv').config();
const config = require('../config/config');
const db = require('../database/db');

(async () => {
  // Validate required env vars (same list as config validation)
  const requiredEnv = ['DATABASE_URL', 'MANAGEMENT_GROUP_ID', 'JWT_SECRET', 'PORT'];
  const missing = requiredEnv.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error('[CHECK] Missing required env vars:', missing.join(', '));
    process.exit(1);
  }

  // Test DB connection
  try {
    // Simple query to verify connection
    const res = await db.query('SELECT 1');
    console.log('[CHECK] Database connection successful:', res.rows[0]);
  } catch (err) {
    console.error('[CHECK] Database connection failed:', err.message);
    process.exit(1);
  }

  console.log('[CHECK] All checks passed.');
  process.exit(0);
})();
