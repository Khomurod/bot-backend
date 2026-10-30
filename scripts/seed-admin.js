/**
 * Seed the initial admin user.
 * Run: ADMIN_USERNAME=… ADMIN_PASSWORD=… node scripts/seed-admin.js
 *
 * Refuses without ADMIN_PASSWORD of at least 10 characters (the screen's rule):
 * before October 2026 it created the account with an EMPTY password, which the
 * sign-in then refused, so the "first admin" could never sign in. An account
 * that already exists keeps its password; an account with no role at all —
 * normally the one just created — is given super_admin here, explicitly,
 * rather than by the boot-time bootstrap. One with any role keeps it.
 */
require('../config/config').assertRequiredConfig();

const bcrypt = require('bcryptjs');
const config = require('../config/config');
const db = require('../database/db');

const MIN_PASSWORD = 10;

(async () => {
  try {
    const username = config.adminUsername;
    const password = config.adminPassword;
    if (String(password || '').length < MIN_PASSWORD) {
      console.error(`[SEED] Set ADMIN_PASSWORD (at least ${MIN_PASSWORD} characters). Nothing was created.`);
      process.exit(1);
    }

    await db.initializeDatabase();
    const hash = await bcrypt.hash(password, 10);

    const admin = await db.createAdmin(username, hash);
    const granted = await db.grantSuperAdminIfRoleless(admin.id);
    console.log(`[SEED] Admin user ensured without resetting an existing password: ${username}`
      + (granted ? ' (given super_admin)' : ''));
    process.exit(0);
  } catch (err) {
    console.error('[SEED] Failed to seed admin:', err.message);
    process.exit(1);
  }
})();
