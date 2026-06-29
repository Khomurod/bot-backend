require('dotenv').config();

const metaAppCredentials = require('./metaAppCredentials.json');
const { loadBitrixFieldMapConfig } = require('../services/bitrix24FieldMapLoader');

const samsaraApiKeysFromEnv = String(process.env.SAMSARA_API_KEYS || '')
  .split(',')
  .map((key) => key.trim())
  .filter(Boolean);
const resolvedSamsaraApiKeys = Array.from(
  new Set([process.env.SAMSARA_API_KEY, ...samsaraApiKeysFromEnv].filter(Boolean))
);

// Validate required environment variables up-front so we fail fast
// with a clear error instead of crashing later at first use.
// NOTE: only true secrets are required here. Non-secret config (group ids,
// USDOT numbers, base URLs, feature flags, etc.) is hardcoded as defaults
// below so it does not need to live in the Render environment. PORT is
// injected automatically by Render.
const requiredEnv = [
  'DATABASE_URL',
  'JWT_SECRET',
  'BOT_TOKEN',
  'TELEGRAM_BOT_TOKEN',
  'FACEBOOK_TOKEN_ENCRYPTION_KEY',
];

const missing = requiredEnv.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error('[CONFIG] Missing required environment variables:', missing.join(', '));
  process.exit(1);
}

// MANAGEMENT_GROUP_ID must be a valid Telegram supergroup/channel id (-100…).
// Telegram groups that are upgraded to supergroups get a new -100-prefixed id;
// the env var MUST be updated at that point — we no longer silently override it.
const managementGroupId = String(process.env.MANAGEMENT_GROUP_ID || '-1002997837889').trim();
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

// Render auto-sets RENDER_EXTERNAL_URL; use it when CORS isn't configured explicitly.
if (corsAllowedOrigins.length === 0 && process.env.RENDER_EXTERNAL_URL) {
  corsAllowedOrigins.push(String(process.env.RENDER_EXTERNAL_URL).replace(/\/+$/, ''));
}

if (process.env.NODE_ENV === 'production' && corsAllowedOrigins.length === 0) {
  throw new Error(
    '[CONFIG] CORS_ALLOWED_ORIGINS must be explicitly set in production environments '
    + '(or set RENDER_EXTERNAL_URL on Render).',
  );
}

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
  if (/placeholder|changeme|your-.+key/i.test(trimmed)) return '';
  const lower = trimmed.toLowerCase();
  if (lower === 'value') return '';
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
  evoEldUsdotNumber: process.env.EVO_ELD_USDOT_NUMBER || process.env.USDOT_NUMBER || '3574434',
  evoEldApiBase: process.env.EVO_ELD_API_BASE || 'https://read.evoeld.com/api/v2',
  ttEldApiKey: process.env.TT_ELD_API_KEY || '',
  ttEldProviderToken: process.env.TT_ELD_PROVIDER_TOKEN || '',
  ttEldUsdotNumber: process.env.TT_ELD_USDOT_NUMBER || process.env.USDOT_NUMBER || '3574434',
  ttEldApiBase: process.env.TT_ELD_API_BASE || 'https://read.tteld.com/api/externalservice',
  dispatchEtaTestGroupId: String(process.env.DISPATCH_ETA_TEST_GROUP_ID || '-5289094495').trim(),
  googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
  googleGeocodingApiBase: process.env.GOOGLE_GEOCODING_API_BASE || 'https://maps.googleapis.com/maps/api/geocode/json',
  googleRoutesApiBase: process.env.GOOGLE_ROUTES_API_BASE || 'https://routes.googleapis.com/directions/v2:computeRoutes',
  employeeGroupId: process.env.EMPLOYEE_GROUP_ID || '-1003284808897',
  corsAllowedOrigins,
  // When true, CORS allows any origin (useful in local dev/testing).
  corsAllowAll: !corsAllowedOrigins.length || process.env.CORS_ALLOW_ALL === 'true',
  nodeEnv: process.env.NODE_ENV || 'development',
  renderExternalUrl: process.env.RENDER_EXTERNAL_URL || '',
  metaAppId: String(process.env.META_APP_ID || metaAppCredentials.metaAppId || '1718688966164172').trim(),
  metaAppSecret: normalizeOptionalEnv(process.env.META_APP_SECRET || metaAppCredentials.metaAppSecret || ''),
  metaLoginConfigId: normalizeOptionalEnv(process.env.META_LOGIN_CONFIG_ID) || '1295127102598424',
  metaGraphVersion: process.env.META_GRAPH_VERSION || 'v25.0',
  metaWebhookVerifyToken: process.env.WEBHOOK_VERIFY_TOKEN || '',
  metaRequestedPermissions: (process.env.META_REQUESTED_PERMISSIONS
    || 'pages_show_list,pages_read_engagement,pages_manage_metadata,leads_retrieval,pages_manage_ads,ads_management,pages_messaging')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  metaAuthPermissions,
  metaAuthLoginConfigId: normalizeOptionalEnv(process.env.META_AUTH_LOGIN_CONFIG_ID),
  adminFacebookUserIds,
  facebookTokenEncryptionKey: process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY,
  leadsInternalSharedSecret: process.env.LEADS_INTERNAL_SHARED_SECRET,
  // Wenze Facebook Leads hub — auto-SMS mirrors + RC inbound forwards (same as leads-bot TELEGRAM_CHAT_ID)
  leadsTelegramChatId: String(process.env.TELEGRAM_CHAT_ID || '-5231255301').trim(),
  // When false, load ingestion skips forwarding parse-failure hints to DISPATCH_ETA_TEST_GROUP_ID.
  // Hardcoded default false (was set to false in the Render environment).
  loadIngestNotifyExtractionFailure:
    process.env.LOAD_INGEST_NOTIFY_EXTRACTION_FAILURE === 'true',
  // Bitrix24 incoming webhook — dual delivery for Facebook leads (default on).
  bitrix24Enabled: process.env.BITRIX24_ENABLED !== 'false',
  bitrix24WebhookUrl: normalizeOptionalEnv(process.env.BITRIX24_WEBHOOK_URL),
  bitrix24Entity: String(process.env.BITRIX24_ENTITY || 'lead').trim().toLowerCase() === 'deal'
    ? 'deal'
    : 'lead',
  // Hardcoded as-is per operator request (kept exactly as the env value).
  bitrix24AssignedById: String(process.env.BITRIX24_ASSIGNED_BY_ID || 'Tom Robinson').trim(),
  bitrix24SourceId: normalizeOptionalEnv(process.env.BITRIX24_SOURCE_ID) || 'WEB',
  bitrix24SourceDescription:
    normalizeOptionalEnv(process.env.BITRIX24_SOURCE_DESCRIPTION) || 'WenzeLeadBots',
  bitrix24DealCategoryId: String(process.env.BITRIX24_DEAL_CATEGORY_ID || '').trim(),
  bitrix24DealStageId: String(process.env.BITRIX24_DEAL_STAGE_ID || '').trim(),
  bitrix24FieldMap: loadBitrixFieldMapConfig(),
  // @datatruck_driver_bot peer reactions / banter in driver groups (requires Bot-to-Bot mode in BotFather)
  datatruckPeerEnabled: process.env.DATATRUCK_PEER_ENABLED !== 'false',
  datatruckPeerBotUsername: String(process.env.DATATRUCK_PEER_BOT_USERNAME || 'datatruck_driver_bot').trim(),
  datatruckLoadFlameChance: Math.min(1, Math.max(0, parseFloat(process.env.DATATRUCK_LOAD_FLAME_CHANCE || '0.35') || 0.35)),
  datatruckBanterMaxPerHourPerChat: Math.max(1, parseInt(process.env.DATATRUCK_BANTER_MAX_PER_HOUR_PER_CHAT || '10', 10) || 10),
  // Datatruck OpenAPI (read-only) — powers the mileage bonus feature.
  // Token is created in the Datatruck dashboard; company is the subdomain
  // (e.g. "wenze" for https://wenze.datatruck.io).
  datatruckApiToken: normalizeOptionalEnv(process.env.DATATRUCK_API_TOKEN),
  datatruckCompany: String(process.env.DATATRUCK_COMPANY || 'wenze').trim().toLowerCase(),
  // Forward Bill of Lading / Proof of Delivery uploads from Datatruck to the
  // matching driver's Telegram group. Read-only polling of the Datatruck
  // OpenAPI; matches each order to its group by unit number, then driver name.
  datatruckDocDeliveryEnabled: process.env.DATATRUCK_DOC_DELIVERY_ENABLED !== 'false',
  // How often to scan for new BOL/POD uploads (minutes).
  datatruckDocPollMinutes: Math.max(1, parseInt(process.env.DATATRUCK_DOC_POLL_MINUTES || '15', 10) || 15),
  // How far back (days) to scan delivered orders for newly-uploaded documents.
  datatruckDocLookbackDays: Math.max(1, parseInt(process.env.DATATRUCK_DOC_LOOKBACK_DAYS || '7', 10) || 7),
  // Documents uploaded before this ISO timestamp are treated as backfill and
  // never sent. When unset, the feature's first-activation time is used.
  datatruckDocSinceIso: normalizeOptionalEnv(process.env.DATATRUCK_DOC_SINCE),
  // Max document size to download+forward when Telegram cannot fetch the URL
  // itself (MB). Telegram bot upload limit is 50MB; default conservatively.
  datatruckDocMaxFileMb: Math.max(1, parseInt(process.env.DATATRUCK_DOC_MAX_FILE_MB || '45', 10) || 45),
  // Datatruck returns document `file_link` as a relative storage key
  // (e.g. "2026/6/27/<uuid>/<file>.pdf"). Prepend this base to build the
  // public, fetchable URL. Trailing slash is normalized at use.
  datatruckDocMediaBaseUrl: String(
    process.env.DATATRUCK_DOC_MEDIA_BASE_URL
    || 'https://tms-datatruck.s3-accelerate.amazonaws.com/static/'
  ).trim(),
  // Gmail App Password channel for driver-raise OTP delivery (no third party).
  // GMAIL_USER is the full address; GMAIL_APP_PASSWORD is a 16-char App Password
  // created at https://myaccount.google.com/apppasswords (2FA required).
  gmailUser: normalizeOptionalEnv(process.env.GMAIL_USER),
  gmailAppPassword: String(process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, ''),
  gmailFrom: normalizeOptionalEnv(process.env.GMAIL_FROM) || normalizeOptionalEnv(process.env.GMAIL_USER),
};
