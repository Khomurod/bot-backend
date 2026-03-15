/**
 * Seed the initial admin user.
 * Run: node scripts/seed-admin.js
 */
const bcrypt = require('bcryptjs');
const config = require('../config/config');
const db = require('../database/db');

(async () => {
  try {
    await db.initializeDatabase();

    const username = config.adminUsername;
    const password = config.adminPassword;
    const hash = await bcrypt.hash(password, 10);

    await db.createAdmin(username, hash);
    console.log(`[SEED] Admin user created: ${username}`);
    process.exit(0);
  } catch (err) {
    console.error('[SEED] Failed to seed admin:', err.message);
    process.exit(1);
  }
})();
