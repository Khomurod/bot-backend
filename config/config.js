require('dotenv').config();

const metaAppCredentials = require('./metaAppCredentials.json');
const { loadBitrixFieldMapConfig } = require('../services/bitrix24FieldMapLoader');
const { resolveTrailerDepartmentEnabled } = require('./trailerDepartmentFlag');

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
  openrouterApiKey: process.env.OPENROUTER_API_KEY,
  samsaraApiKey: process.env.SAMSARA_API_KEY || resolvedSamsaraApiKeys[0] || '',
  samsaraApiKeys: resolvedSamsaraApiKeys,
  samsaraApiBase: process.env.SAMSARA_API_BASE || 'https://api.samsara.com',
  // Drive HoS ELD platform — powers the Factor ELD and Leader ELD live-location
  // fallbacks (replacing the retired TT ELD / EVO ELD integrations). These are
  // env fallbacks only; the admin Settings tab (eld_settings) is the primary,
  // runtime-editable source of these credentials.
  driveHosApiBase: process.env.DRIVEHOS_API_BASE || 'https://api.drivehos.app',
  driveHosProviderKey: process.env.DRIVEHOS_PROVIDER_KEY || '',
  factorEldCompanyKey: process.env.FACTOR_ELD_COMPANY_KEY || '',
  leaderEldCompanyKey: process.env.LEADER_ELD_COMPANY_KEY || '',
  // RingCentral recruiter-call KPIs. Env fallbacks only; the admin Settings tab
  // (ringcentral_settings) is the primary, runtime-editable source.
  rcClientId: process.env.RC_CLIENT_ID || '',
  rcClientSecret: process.env.RC_CLIENT_SECRET || '',
  rcJwtToken: process.env.RC_JWT_TOKEN || '',
  rcApiBase: process.env.RC_API_BASE || 'https://platform.ringcentral.com',
  dispatchEtaTestGroupId: String(process.env.DISPATCH_ETA_TEST_GROUP_ID || '-5289094495').trim(),
  // Trailer Tracking (Beta): the "Automatic updating (Test)" group that receives
  // unidentified/unclear trailer commands for review. Env fallback only — the
  // primary, runtime-editable source is trailer_settings.automatic_update_test_group_id.
  // Defaults to the shared automatic-updating test group.
  trailerTestGroupId: String(process.env.TRAILER_TEST_GROUP_ID || process.env.DISPATCH_ETA_TEST_GROUP_ID || '-5289094495').trim(),
  // Enabled unless TRAILER_DEPARTMENT_ENABLED is explicitly "false" (the
  // emergency kill switch). A restart is required after changing it.
  trailerDepartmentEnabled: resolveTrailerDepartmentEnabled(process.env.TRAILER_DEPARTMENT_ENABLED),
  // Master-list snapshot import limits. The whole official trailer list arrives
  // as many photos, and this runs on a memory-constrained instance, so the caps
  // are configurable rather than baked in. Images are processed one at a time
  // from temp disk (services/trailerMasterList/imageIngest.js).
  trailerMasterImportMaxImages: Number.parseInt(process.env.TRAILER_MASTER_IMPORT_MAX_IMAGES || '12', 10),
  trailerMasterImportMaxImageBytes: Number.parseInt(process.env.TRAILER_MASTER_IMPORT_MAX_IMAGE_BYTES || String(8 * 1024 * 1024), 10),
  trailerMasterImportMaxTotalBytes: Number.parseInt(process.env.TRAILER_MASTER_IMPORT_MAX_TOTAL_BYTES || String(64 * 1024 * 1024), 10),
  supabaseUrl: normalizeOptionalEnv(process.env.SUPABASE_URL),
  supabaseServiceRoleKey: normalizeOptionalEnv(process.env.SUPABASE_SERVICE_ROLE_KEY),
  trailerStorageBucket: String(process.env.TRAILER_STORAGE_BUCKET || 'trailer-private').trim(),
  googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
  googleGeocodingApiBase: process.env.GOOGLE_GEOCODING_API_BASE || 'https://maps.googleapis.com/maps/api/geocode/json',
  googleRoutesApiBase: process.env.GOOGLE_ROUTES_API_BASE || 'https://routes.googleapis.com/directions/v2:computeRoutes',
  // Live Locations map tiles. Served only to authenticated admins via
  // GET /api/live-locations/config, so no map key is baked into the frontend
  // bundle. Leave unset to use OpenStreetMap tiles (fine for low-volume internal
  // admin use); set a MapTiler/Mapbox raster tile URL for production scale.
  mapTileUrl: process.env.MAP_TILE_URL || '',
  mapTileAttribution: process.env.MAP_TILE_ATTRIBUTION || '',
  employeeGroupId: process.env.EMPLOYEE_GROUP_ID || '-1003284808897',
  // Telegram destinations for the bonus / CPM-review message categories. These
  // are OPTIONAL, backwards-compatible env fallbacks only — the primary,
  // runtime-editable source of truth is the admin Settings → Telegram Groups tab
  // (message_group_settings). Deliberately NO hardcoded group-id default: when a
  // category has neither a DB value nor an env value, its message is not sent
  // and a clear configuration error is logged (never a silent old default).
  mileageBonusGroupId: String(process.env.MILEAGE_BONUS_GROUP_CHAT_ID || '').trim(),
  roadBonusGroupId: String(process.env.ROAD_BONUS_GROUP_CHAT_ID || '').trim(),
  dispatchReviewGroupId: String(process.env.DISPATCH_REVIEW_GROUP_CHAT_ID || '').trim(),
  // Anonymous Feedback — private-chat flow that asks the sender whether they are
  // an employee or a driver, then relays their complaint / request / inquiry to
  // this group WITHOUT any identifying information (no username, name, or id).
  anonymousFeedbackGroupId: String(process.env.ANONYMOUS_FEEDBACK_GROUP_ID || '-1002997837889').trim(),
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
  // OpenAPI; matches each order to its group by driver name only.
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
  // BOL/POD forwarding: classification comes from DataTruck's authoritative
  // `file_type` (deterministic). This flag enables a defensive AI vision
  // fallback for the rare document whose type cannot be determined from
  // metadata. OFF by default — a genuinely-uncertain document otherwise
  // follows the admin's uncertain_document_policy without any AI call.
  bolPodAiFallbackEnabled: process.env.BOL_POD_AI_FALLBACK_ENABLED === 'true',
  // Gmail App Password channel for driver-raise OTP delivery (no third party).
  // GMAIL_USER is the full address; GMAIL_APP_PASSWORD is a 16-char App Password
  // created at https://myaccount.google.com/apppasswords (2FA required).
  gmailUser: normalizeOptionalEnv(process.env.GMAIL_USER),
  gmailAppPassword: String(process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, ''),
  gmailFrom: normalizeOptionalEnv(process.env.GMAIL_FROM) || normalizeOptionalEnv(process.env.GMAIL_USER),
};
