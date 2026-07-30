/**
 * Initialize the database schema.
 * Run: node scripts/init-db.js
 */
require('../config/config').assertRequiredConfig();

const db = require('../database/db');

(async () => {
  try {
    console.log('[INIT] Initializing database...');
    await db.initializeDatabase();
    console.log('[INIT] Database initialized successfully.');
    process.exit(0);
  } catch (err) {
    console.error('[INIT] Failed to initialize database:', err.message);
    process.exit(1);
  }
})();
