require('dotenv').config();

// Validate required environment variables up-front so we fail fast
// with a clear error instead of crashing later at first use.
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

// MANAGEMENT_GROUP_ID must be a valid Telegram supergroup/channel id (-100…).
// Telegram groups that are upgraded to supergroups get a new -100-prefixed id;
// the env var MUST be updated at that point — we no longer silently override it.
const managementGroupId = String(process.env.MANAGEMENT_GROUP_ID).trim();
if (!/^-?\d+$/.test(managementGroupId)) {
  console.error(`[CONFIG] MANAGEMENT_GROUP_ID is not a numeric chat id: "${managementGroupId}"`);
  process.exit(1);
}

const mediaStorageChatId = String(process.env.MEDIA_STORAGE_CHAT_ID || managementGroupId).trim();
if (!/^-?\d+$/.test(mediaStorageChatId)) {
  console.error(`[CONFIG] MEDIA_STORAGE_CHAT_ID is not a numeric chat id: "${mediaStorageChatId}"`);
  process.exit(1);
}

// Allow-list of CORS origins for the admin panel (comma-separated) — falls back to
// permissive wildcard only when explicitly opted into (dev convenience).
const corsOriginsEnv = process.env.CORS_ALLOWED_ORIGINS || '';
const corsAllowedOrigins = corsOriginsEnv
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

module.exports = {
  botToken: process.env.BOT_TOKEN,
  databaseUrl: process.env.DATABASE_URL,
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin123',
  managementGroupId,
  mediaStorageChatId,
  jwtSecret: process.env.JWT_SECRET || 'driver-feedback-jwt-secret-key',
  port: process.env.PORT || 3001,
  openaiApiKey: process.env.OPENAI_API_KEY,
  openrouterApiKey: process.env.OPENROUTER_API_KEY,
  samsaraApiKey: process.env.SAMSARA_API_KEY,
  samsaraApiBase: process.env.SAMSARA_API_BASE || 'https://api.samsara.com',
  employeeGroupId: process.env.EMPLOYEE_GROUP_ID,
  corsAllowedOrigins,
  // When true, CORS allows any origin (useful in local dev/testing).
  corsAllowAll: !corsAllowedOrigins.length || process.env.CORS_ALLOW_ALL === 'true',
  nodeEnv: process.env.NODE_ENV || 'development',
};
