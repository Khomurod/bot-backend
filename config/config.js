require('dotenv').config();
const HARDCODED_MANAGEMENT_GROUP_ID = '-1002997837889';

// Validate required environment variables
const requiredEnv = [
  'BOT_TOKEN',
  'DATABASE_URL',
  'MANAGEMENT_GROUP_ID',
  'JWT_SECRET',
  'PORT',
];

const missing = requiredEnv.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error('[CONFIG] Missing required environment variables:', missing.join(', '));
  process.exit(1);
}

module.exports = {
  botToken: process.env.BOT_TOKEN,
  databaseUrl: process.env.DATABASE_URL,
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin123',
  // Forced override to avoid stale env values after Telegram group->supergroup migration.
  managementGroupId: HARDCODED_MANAGEMENT_GROUP_ID,
  jwtSecret: process.env.JWT_SECRET || 'driver-feedback-jwt-secret-key',
  port: process.env.PORT || 3001,
  openaiApiKey: process.env.OPENAI_API_KEY,
  employeeGroupId: process.env.EMPLOYEE_GROUP_ID,
};
