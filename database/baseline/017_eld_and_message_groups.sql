-- ─────────────────────────────────────────────────────────────────────────
-- TABLE: eld_settings — single-row store for the live truck-location provider
-- credentials, editable from the admin panel's Settings tab. Samsara stays the
-- primary source; Factor ELD and Leader ELD (both on the shared Drive HoS
-- platform, api.drivehos.app) are the fallbacks, replacing the retired TT/EVO
-- integrations.
--
-- Drive HoS auth needs two keys per request: one shared X-API-Provider-Key
-- (identifies our integration / "AlgoService") and a per-carrier
-- X-API-Company-Key (one for the Factor fleet, one for the Leader fleet). All
-- secrets are stored encrypted with the same AES-256-GCM scheme as Facebook
-- tokens (FACEBOOK_TOKEN_ENCRYPTION_KEY). When a *_encrypted column is NULL the
-- app falls back to the matching environment variable.
CREATE TABLE IF NOT EXISTS eld_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  -- Samsara (primary). API key overrides SAMSARA_API_KEY / SAMSARA_API_KEYS.
  samsara_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  samsara_api_key_encrypted TEXT NULL,
  -- Drive HoS shared provider key (X-API-Provider-Key). Same for both fleets.
  drivehos_provider_key_encrypted TEXT NULL,
  drivehos_api_base TEXT NOT NULL DEFAULT 'https://api.drivehos.app',
  -- Factor ELD carrier company key (X-API-Company-Key).
  factor_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  factor_company_key_encrypted TEXT NULL,
  -- Leader ELD carrier company key (X-API-Company-Key).
  leader_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  leader_company_key_encrypted TEXT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO eld_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────
-- TABLE: message_group_settings — single-row store for the Telegram group each
-- bonus / review message category is sent to. These IDs used to be hardcoded
-- constants / default env values (BONUS_GROUP_CHAT_ID, EMPLOYEE_GROUP_ID); they
-- are now edited in the admin panel's Settings → Telegram Groups tab.
--
-- Telegram group IDs are NOT secrets — they are stored and shown in plaintext so
-- an admin can read and edit them. Each category has its OWN destination; enter
-- the same ID in several fields to share a group. When a *_group_id is NULL the
-- app falls back to the matching optional environment variable, and when neither
-- is set the message is NOT sent and a clear configuration error is logged.
CREATE TABLE IF NOT EXISTS message_group_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  -- Extra Mile / Mileage Bonus milestone cards (services/mileageBonusService).
  mileage_bonus_group_id TEXT NULL,
  -- Extra Week / Road Bonus summary posted when a driver comes home over the
  -- road allowance (services/roadBonusNotifierService).
  road_bonus_group_id TEXT NULL,
  -- 72–75 CPM / Dispatch Rate Review request + result summary
  -- (services/raiseApprovalService).
  dispatch_review_group_id TEXT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO message_group_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────
-- RingCentral recruiter-call KPIs.
--
-- The bot polls the RingCentral company Call Log, attributes each call to a
-- recruiter by matching the recruiter's dedicated direct number, and rolls the
-- calls up into per-recruiter daily KPIs (outbound volume + conversation
-- quality by duration) against the recruiter targets. Credentials are entered
-- in the admin Settings tab and stored encrypted (AES-256-GCM, same scheme as
-- Facebook tokens / ELD keys).
