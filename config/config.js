require('dotenv').config();

const metaAppCredentials = require('./metaAppCredentials.json');

const samsaraApiKeysFromEnv = String(process.env.SAMSARA_API_KEYS || '')
  .split(',')
  .map((key) => key.trim())
  .filter(Boolean);
const resolvedSamsaraApiKeys = Array.from(
  new Set([process.env.SAMSARA_API_KEY, ...samsaraApiKeysFromEnv].filter(Boolean))
);

// Validate required environment variables up-front so we fail fast
// with a clear error instead of crashing later at first use.
const requiredEnv = [
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

const adminFacebookUserIds = String(process.env.ADMIN_FACEBOOK_USER_IDS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const metaAuthPermissions = (process.env.META_AUTH_PERMISSIONS || 'public_profile')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

/** Render/Meta UIs sometimes leave literal placeholder strings in env vars. */
function normalizeOptionalEnv(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();
  if (lower === 'value' || lower === 'placeholder' || lower === 'changeme') return '';
  return trimmed;
}

module.exports = {
  botToken: process.env.BOT_TOKEN || '',
  databaseUrl: process.env.DATABASE_URL,
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  managementGroupId,
  mediaStorageChatId,
  jwtSecret: process.env.JWT_SECRET || '',
  port: process.env.PORT || 3001,
  openaiApiKey: process.env.OPENAI_API_KEY,
  openrouterApiKey: process.env.OPENROUTER_API_KEY,
  samsaraApiKey: process.env.SAMSARA_API_KEY || resolvedSamsaraApiKeys[0] || '',
  samsaraApiKeys: resolvedSamsaraApiKeys,
  samsaraApiBase: process.env.SAMSARA_API_BASE || 'https://api.samsara.com',
  evoEldApiKey: process.env.EVO_ELD_API_KEY || '',
  evoEldProviderToken: process.env.EVO_ELD_PROVIDER_TOKEN || '',
  evoEldUsdotNumber: process.env.EVO_ELD_USDOT_NUMBER || process.env.USDOT_NUMBER || '',
  evoEldApiBase: process.env.EVO_ELD_API_BASE || 'https://read.evoeld.com/api/v2',
  ttEldApiKey: process.env.TT_ELD_API_KEY || '',
  ttEldProviderToken: process.env.TT_ELD_PROVIDER_TOKEN || '',
  ttEldUsdotNumber: process.env.TT_ELD_USDOT_NUMBER || process.env.USDOT_NUMBER || '',
  ttEldApiBase: process.env.TT_ELD_API_BASE || 'https://read.tteld.com/api/externalservice',
  dispatchEtaTestGroupId: String(process.env.DISPATCH_ETA_TEST_GROUP_ID || '').trim(),
  googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
  googleGeocodingApiBase: process.env.GOOGLE_GEOCODING_API_BASE || 'https://maps.googleapis.com/maps/api/geocode/json',
  googleRoutesApiBase: process.env.GOOGLE_ROUTES_API_BASE || 'https://routes.googleapis.com/directions/v2:computeRoutes',
  employeeGroupId: process.env.EMPLOYEE_GROUP_ID,
  corsAllowedOrigins,
  // When true, CORS allows any origin (useful in local dev/testing).
  corsAllowAll: !corsAllowedOrigins.length || process.env.CORS_ALLOW_ALL === 'true',
  nodeEnv: process.env.NODE_ENV || 'development',
  renderExternalUrl: process.env.RENDER_EXTERNAL_URL || '',
  metaAppId: String(process.env.META_APP_ID || metaAppCredentials.metaAppId || '').trim(),
  metaAppSecret: normalizeOptionalEnv(process.env.META_APP_SECRET || metaAppCredentials.metaAppSecret || ''),
  metaLoginConfigId: normalizeOptionalEnv(process.env.META_LOGIN_CONFIG_ID),
  metaGraphVersion: process.env.META_GRAPH_VERSION || 'v25.0',
  metaWebhookVerifyToken: process.env.WEBHOOK_VERIFY_TOKEN || '',
  metaRequestedPermissions: (process.env.META_REQUESTED_PERMISSIONS
    || 'pages_show_list,pages_read_engagement,pages_manage_metadata,leads_retrieval,pages_manage_ads,ads_management,pages_messaging,business_management')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  metaAuthPermissions,
  metaAuthLoginConfigId: normalizeOptionalEnv(process.env.META_AUTH_LOGIN_CONFIG_ID),
  adminFacebookUserIds,
  facebookTokenEncryptionKey: process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY || process.env.JWT_SECRET || '',
  leadsInternalSharedSecret: process.env.LEADS_INTERNAL_SHARED_SECRET || process.env.JWT_SECRET || '',
  // When false, load ingestion skips forwarding parse-failure hints to DISPATCH_ETA_TEST_GROUP_ID.
  loadIngestNotifyExtractionFailure:
    process.env.LOAD_INGEST_NOTIFY_EXTRACTION_FAILURE !== 'false',
};
