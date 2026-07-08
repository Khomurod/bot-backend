# Database — Current Schema (generated)

> **Do not edit by hand.** Regenerate with `npm run db:docs` (see
> `docs/database/README.md`). Every schema-changing PR must re-run it.

Generated from an introspected database (76 tables). Structure only — no row data.

**Tables:** 76

## Tables

- [`admins`](#admins) — 🟢 active
- [`ai_insights`](#ai_insights) — 🟢 active
- [`ai_reports`](#ai_reports) — 🟢 active
- [`bot_access_settings`](#bot_access_settings) — 🟢 active
- [`bot_sent_messages`](#bot_sent_messages) — 🟢 active — - Telegram forwards from ordinary groups do not reliably expose the original
- [`bot_users`](#bot_users) — 🟢 active — Everyone who has interacted with the bot (Telegram user id, last seen, etc.).
- [`broadcast_button_clicks`](#broadcast_button_clicks) — 🟢 active
- [`broadcast_deliveries`](#broadcast_deliveries) — 🟢 active
- [`broadcasts`](#broadcasts) — 🟢 active
- [`chat_logs`](#chat_logs) — 🟢 active — Captured Telegram group messages used for AI insights/annotations.
- [`chat_message_annotations`](#chat_message_annotations) — 🟢 active
- [`datatruck_document_deliveries`](#datatruck_document_deliveries) — 🟢 active
- [`dispatch_eta_global_settings`](#dispatch_eta_global_settings) — 🟢 active
- [`dispatch_eta_updates`](#dispatch_eta_updates) — 🟢 active
- [`dispatch_team_drivers`](#dispatch_team_drivers) — 🟢 active
- [`dispatch_team_members`](#dispatch_team_members) — 🟢 active
- [`dispatch_teams`](#dispatch_teams) — 🟢 active
- [`driver_home_status`](#driver_home_status) — 🟢 active
- [`driver_location_checkins`](#driver_location_checkins) — 🟡 legacy — Driver location check-in records.
- [`driver_location_monitors`](#driver_location_monitors) — 🟡 legacy — Per-group location-monitor scheduler rows.
- [`driver_profiles`](#driver_profiles) — 🟢 active — Per-driver-group profile (one active profile per driver group).
- [`driver_road_history`](#driver_road_history) — 🟢 active
- [`drivers`](#drivers) — 🟢 active — Driver identity records keyed by Telegram user id.
- [`duplicate_unit_reports`](#duplicate_unit_reports) — 🟢 active
- [`eld_settings`](#eld_settings) — 🟢 active — Single-row (id=1) ELD/telematics provider credentials (Samsara, Drive HoS, Factor, Leader). Secrets stored AES-256-GCM encrypted.
- [`employee_birthday_settings`](#employee_birthday_settings) — 🟢 active
- [`employee_birthdays`](#employee_birthdays) — 🟢 active
- [`employee_votes`](#employee_votes) — 🟢 active
- [`employee_votes_options`](#employee_votes_options) — 🟢 active
- [`employee_votes_polls`](#employee_votes_polls) — 🟢 active
- [`facebook_connect_sessions`](#facebook_connect_sessions) — 🟢 active
- [`facebook_lead_auto_message_rules`](#facebook_lead_auto_message_rules) — 🟢 active
- [`facebook_lead_auto_message_settings`](#facebook_lead_auto_message_settings) — 🟢 active
- [`facebook_lead_sms_mirrors`](#facebook_lead_sms_mirrors) — 🟢 active
- [`facebook_page_connections`](#facebook_page_connections) — 🟢 active
- [`facebook_seen_senders`](#facebook_seen_senders) — 🟢 active
- [`facebook_webhook_events`](#facebook_webhook_events) — 🟢 active
- [`fuel_monitor_inbox`](#fuel_monitor_inbox) — 🟢 active
- [`fuel_stop_alerts`](#fuel_stop_alerts) — 🟢 active
- [`gmaps_settings`](#gmaps_settings) — 🟢 active — Single-row (id=1) Google Maps Platform config for Route Control. Server key encrypted at rest.
- [`group_members`](#group_members) — 🟢 active — which Telegram users the bot has SEEN in each group.
- [`group_pinned_messages`](#group_pinned_messages) — 🟢 active — - Stores the latest pinned-message snapshot we observed in updates for each
- [`group_recent_loads`](#group_recent_loads) — 🟢 active
- [`groups`](#groups) — 🟢 active — Every Telegram group the bot manages — driver groups, dispatch/office groups, etc. Internal integer `id` is the FK target used everywhere; `telegram_group_id` (bigint) is the real Telegram chat id. `group_type='driver'` + a unit number in `group_name` is how the Samsara integration routes safety-event videos to the right driver group.
- [`home_time_requests`](#home_time_requests) — 🟢 active
- [`home_time_settings`](#home_time_settings) — 🟢 active
- [`leads`](#leads) — 🟢 active — Recruiting leads ingested from external sources (Facebook, Indeed, Bitrix).
- [`message_group_settings`](#message_group_settings) — 🟢 active — Single-row (id=1) map of message category → destination Telegram group id (stored as text). Telegram group ids are not secrets.
- [`mileage_bonus_notifications`](#mileage_bonus_notifications) — 🟢 active
- [`mileage_bonus_progress`](#mileage_bonus_progress) — 🟢 active
- [`mileage_bonus_runs`](#mileage_bonus_runs) — 🟢 active
- [`option_translations`](#option_translations) — 🟢 active
- [`options`](#options) — 🟢 active
- [`question_media`](#question_media) — 🟢 active
- [`question_translations`](#question_translations) — 🟢 active
- [`questions`](#questions) — 🟢 active
- [`raise_otp`](#raise_otp) — 🟢 active
- [`raise_round_picks`](#raise_round_picks) — 🟢 active
- [`raise_round_submissions`](#raise_round_submissions) — 🟢 active
- [`raise_rounds`](#raise_rounds) — 🟢 active
- [`raise_settings`](#raise_settings) — 🟢 active
- [`recruiters`](#recruiters) — 🟢 active
- [`responses`](#responses) — 🟢 active
- [`ringcentral_calls`](#ringcentral_calls) — 🟢 active
- [`ringcentral_settings`](#ringcentral_settings) — 🟢 active — Single-row (id=1) RingCentral call-KPI credentials + thresholds. Secrets encrypted.
- [`route_assignments`](#route_assignments) — 🟢 active
- [`route_monitor_events`](#route_monitor_events) — 🟢 active
- [`safety_event_music_assets`](#safety_event_music_assets) — 🟢 active — Uploaded background-music clips for the driver-group speeding-video overlay. Bytes are stored in Postgres BYTEA (storage_kind='db_bytea') because the samsara-integration poller runs as a SEPARATE process with a DIFFERENT Telegram bot and Telegram file_ids are bot-scoped. Exactly one row is active at a time (partial unique index).
- [`safety_event_video_jobs`](#safety_event_video_jobs) — 🟢 active — Best-effort observability ledger: one row per driver-group music-overlay attempt (pending→processing→sent/failed/fallback_sent/skipped). Written by the samsara-integration poller.
- [`safety_event_video_settings`](#safety_event_video_settings) — 🟢 active — Single-row (id=1) config for the driver-group music overlay: enable flags, active music asset, volume, fades, mix-vs-replace, loop behaviour, and a max-video-length cap. `samsara_notification_group_original_video_enabled` documents (and never overrides) the invariant that the notifications group always gets the original video.
- [`samsara_event_deliveries`](#samsara_event_deliveries) — 🟢 active — Per-(event, target_chat_id) idempotent delivery ledger — the source of truth for 'already sent, do not resend'. status ∈ delivered|permanent; a delivered row is never downgraded.
- [`samsara_poll_state`](#samsara_poll_state) — 🟢 active — Key/value poll watermarks + pagination cursors for the two Samsara pollers.
- [`samsara_processed_events`](#samsara_processed_events) — 🟢 active — Durable dedup set of Samsara safety/speeding event ids already handled, so restarts/redeploys never re-broadcast.
- [`scheduled_messages`](#scheduled_messages) — 🟢 active
- [`sender_role_consensus`](#sender_role_consensus) — 🟢 active
- [`service_runs`](#service_runs) — 🟢 active

## admins

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('admins_id_seq'::regclass)` |
| `username` | `text` | NOT NULL |
| `password_hash` | `text` | NOT NULL |
| `created_at` | `timestamp without time zone` | null default `now()` |

- **Primary key:** `PRIMARY KEY (id)`
- **Unique:**
  - `UNIQUE (username)`

## ai_insights

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('ai_insights_id_seq'::regclass)` |
| `report_id` | `integer` | null |
| `kind` | `character varying(32)` | NOT NULL |
| `severity` | `smallint` | null default `1` |
| `rank` | `integer` | null default `0` |
| `title` | `text` | NOT NULL |
| `narrative_html` | `text` | null |
| `suggested_action` | `text` | null |
| `evidence_json` | `jsonb` | null |
| `metrics_json` | `jsonb` | null |
| `driver_name` | `text` | null |
| `driver_telegram_id` | `bigint` | null |
| `group_id` | `integer` | null |
| `status` | `character varying(16)` | null default `'pending'::character varying` |
| `admin_feedback` | `text` | null |
| `created_at` | `timestamp without time zone` | null default `now()` |
| `updated_at` | `timestamp without time zone` | null default `now()` |

- **Primary key:** `PRIMARY KEY (id)`
- **Foreign keys:**
  - `FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE SET NULL`
  - `FOREIGN KEY (report_id) REFERENCES ai_reports(id) ON DELETE CASCADE`
- **Checks:**
  - `CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'approved'::character varying, 'dismissed'::character varying, 'edited'::character varying, 'sent'::character varying])::text[])))`
- **Indexes:**
  - `CREATE INDEX idx_ai_insights_group_id ON public.ai_insights USING btree (group_id)`
  - `CREATE INDEX idx_ai_insights_kind_severity ON public.ai_insights USING btree (kind, severity DESC)`
  - `CREATE INDEX idx_ai_insights_report_id ON public.ai_insights USING btree (report_id)`
  - `CREATE INDEX idx_ai_insights_status ON public.ai_insights USING btree (status)`

## ai_reports

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('ai_reports_id_seq'::regclass)` |
| `group_id` | `integer` | null |
| `report_text` | `text` | NOT NULL |
| `report_type` | `character varying(50)` | NOT NULL default `'driver'::character varying` |
| `status` | `character varying(20)` | NOT NULL default `'draft'::character varying` |
| `generated_at` | `timestamp without time zone` | NOT NULL default `now()` |
| `sent_at` | `timestamp without time zone` | null |

- **Primary key:** `PRIMARY KEY (id)`
- **Foreign keys:**
  - `FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE`
- **Checks:**
  - `CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, 'sent'::character varying, 'discarded'::character varying])::text[])))`
  - `CHECK (((report_type)::text = ANY ((ARRAY['driver'::character varying, 'company'::character varying])::text[])))`
- **Indexes:**
  - `CREATE INDEX idx_ai_reports_group_id ON public.ai_reports USING btree (group_id)`
  - `CREATE INDEX idx_ai_reports_status_generated_at ON public.ai_reports USING btree (status, generated_at DESC)`

## bot_access_settings

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `1` |
| `super_admin_telegram_id` | `bigint` | null |
| `super_admin_label` | `text` | null |
| `updated_at` | `timestamp with time zone` | NOT NULL default `now()` |

- **Primary key:** `PRIMARY KEY (id)`
- **Checks:**
  - `CHECK ((id = 1))`

## bot_sent_messages

- **Status:** 🟢 active
- **Purpose:** - Telegram forwards from ordinary groups do not reliably expose the original

| Column | Type | Nullability |
|---|---|---|
| `id` | `bigint` | NOT NULL default `nextval('bot_sent_messages_id_seq'::regclass)` |
| `telegram_chat_id` | `bigint` | NOT NULL |
| `telegram_message_id` | `bigint` | NOT NULL |
| `sent_at` | `timestamp with time zone` | null |
| `message_text` | `text` | null |
| `content_kind` | `text` | NOT NULL default `'other'::text` |
| `source_method` | `text` | null |
| `edited_at` | `timestamp with time zone` | null |
| `deleted_at` | `timestamp with time zone` | null |
| `created_at` | `timestamp with time zone` | NOT NULL default `now()` |
| `updated_at` | `timestamp with time zone` | NOT NULL default `now()` |
| `last_edit_text` | `text` | null |

- **Primary key:** `PRIMARY KEY (id)`
- **Unique:**
  - `UNIQUE (telegram_chat_id, telegram_message_id)`
- **Indexes:**
  - `CREATE INDEX idx_bot_sent_messages_forward_lookup ON public.bot_sent_messages USING btree (sent_at DESC, telegram_chat_id) WHERE (deleted_at IS NULL)`
  - `CREATE INDEX idx_bot_sent_messages_recent ON public.bot_sent_messages USING btree (sent_at DESC NULLS LAST, id DESC)`

## bot_users

- **Status:** 🟢 active
- **Used by:** bot, admin
- **Purpose:** Everyone who has interacted with the bot (Telegram user id, last seen, etc.).

| Column | Type | Nullability |
|---|---|---|
| `telegram_user_id` | `bigint` | NOT NULL |
| `username` | `text` | null |
| `first_name` | `text` | null |
| `last_name` | `text` | null |
| `interactions` | `integer` | NOT NULL default `0` |
| `last_action` | `text` | null |
| `last_group_id` | `integer` | null |
| `first_seen_at` | `timestamp with time zone` | NOT NULL default `now()` |
| `last_interaction_at` | `timestamp with time zone` | NOT NULL default `now()` |

- **Primary key:** `PRIMARY KEY (telegram_user_id)`
- **Indexes:**
  - `CREATE INDEX idx_bot_users_last_interaction ON public.bot_users USING btree (last_interaction_at DESC)`

## broadcast_button_clicks

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('broadcast_button_clicks_id_seq'::regclass)` |
| `broadcast_id` | `integer` | null |
| `button_index` | `integer` | NOT NULL |
| `button_label` | `text` | null |
| `driver_telegram_id` | `bigint` | NOT NULL |
| `driver_username` | `text` | null |
| `driver_first_name` | `text` | null |
| `driver_last_name` | `text` | null |
| `group_telegram_id` | `bigint` | null |
| `group_name` | `text` | null |
| `clicked_at` | `timestamp without time zone` | null default `now()` |

- **Primary key:** `PRIMARY KEY (id)`
- **Foreign keys:**
  - `FOREIGN KEY (broadcast_id) REFERENCES broadcasts(id) ON DELETE CASCADE`
- **Unique:**
  - `UNIQUE (broadcast_id, button_index, driver_telegram_id)`
- **Indexes:**
  - `CREATE INDEX idx_broadcast_button_clicks_broadcast_id ON public.broadcast_button_clicks USING btree (broadcast_id)`

## broadcast_deliveries

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('broadcast_deliveries_id_seq'::regclass)` |
| `broadcast_id` | `integer` | null |
| `group_id` | `integer` | null |
| `telegram_group_id` | `bigint` | null |
| `group_name` | `text` | null |
| `status` | `text` | null default `'sent'::text` |
| `error_message` | `text` | null |
| `sent_at` | `timestamp without time zone` | null default `now()` |

- **Primary key:** `PRIMARY KEY (id)`
- **Foreign keys:**
  - `FOREIGN KEY (broadcast_id) REFERENCES broadcasts(id) ON DELETE CASCADE`
- **Indexes:**
  - `CREATE INDEX idx_broadcast_deliveries_broadcast_id ON public.broadcast_deliveries USING btree (broadcast_id)`

## broadcasts

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('broadcasts_id_seq'::regclass)` |
| `type` | `text` | NOT NULL default `'regular'::text` |
| `message_text_en` | `text` | null |
| `message_text_ru` | `text` | null |
| `message_text_uz` | `text` | null |
| `media_items` | `jsonb` | null |
| `media_position` | `text` | null default `'above'::text` |
| `parse_mode` | `text` | null default `'HTML'::text` |
| `buttons` | `jsonb` | null |
| `target_type` | `text` | null default `'all'::text` |
| `target_driver_ids` | `integer[]` | null |
| `target_languages` | `text[]` | null |
| `force_language` | `text` | null |
| `status` | `text` | null default `'sent'::text` |
| `sent_at` | `timestamp without time zone` | null default `now()` |
| `created_at` | `timestamp without time zone` | null default `now()` |
| `target_active_filter` | `text` | null |

- **Primary key:** `PRIMARY KEY (id)`

## chat_logs

- **Status:** 🟢 active
- **Used by:** bot, ai services
- **Purpose:** Captured Telegram group messages used for AI insights/annotations.
- **⚠️ Data-safety note:** Contains message content (potential PII). Large table — index-sensitive.

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('chat_logs_id_seq'::regclass)` |
| `group_id` | `integer` | null |
| `telegram_user_id` | `bigint` | null |
| `telegram_message_id` | `bigint` | null |
| `sender_name` | `text` | null |
| `message_text` | `text` | NOT NULL |
| `created_at` | `timestamp without time zone` | null default `now()` |

- **Primary key:** `PRIMARY KEY (id)`
- **Foreign keys:**
  - `FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE`
- **Indexes:**
  - `CREATE INDEX idx_chat_logs_created_at ON public.chat_logs USING btree (created_at DESC)`
  - `CREATE INDEX idx_chat_logs_group_id_created_at ON public.chat_logs USING btree (group_id, created_at DESC)`

## chat_message_annotations

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `chat_log_id` | `integer` | NOT NULL |
| `language` | `character varying(8)` | null |
| `intent` | `character varying(32)` | null |
| `sentiment` | `smallint` | null |
| `urgency` | `smallint` | null |
| `role_guess` | `character varying(16)` | null |
| `role_confidence` | `smallint` | null |
| `is_acknowledgement` | `boolean` | null |
| `toxic` | `boolean` | null |
| `entities_json` | `jsonb` | null |
| `model_version` | `text` | null |
| `annotated_at` | `timestamp without time zone` | null default `now()` |

- **Primary key:** `PRIMARY KEY (chat_log_id)`
- **Foreign keys:**
  - `FOREIGN KEY (chat_log_id) REFERENCES chat_logs(id) ON DELETE CASCADE`
- **Indexes:**
  - `CREATE INDEX idx_annotations_annotated_at ON public.chat_message_annotations USING btree (annotated_at DESC)`
  - `CREATE INDEX idx_annotations_intent ON public.chat_message_annotations USING btree (intent)`
  - `CREATE INDEX idx_annotations_role ON public.chat_message_annotations USING btree (role_guess)`

## datatruck_document_deliveries

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `bigint` | NOT NULL default `nextval('datatruck_document_deliveries_id_seq'::regclass)` |
| `signature` | `text` | NOT NULL |
| `order_id` | `text` | null |
| `load_reference` | `text` | null |
| `file_type` | `text` | NOT NULL |
| `file_link` | `text` | null |
| `uploaded_by` | `text` | null |
| `uploaded_at` | `timestamp with time zone` | null |
| `driver_name` | `text` | null |
| `unit_number` | `text` | null |
| `matched_by` | `text` | null |
| `group_id` | `integer` | null |
| `telegram_group_id` | `bigint` | null |
| `status` | `text` | NOT NULL default `'pending'::text` |
| `telegram_message_id` | `bigint` | null |
| `attempt_count` | `integer` | NOT NULL default `0` |
| `last_error` | `text` | null |
| `created_at` | `timestamp with time zone` | NOT NULL default `now()` |
| `updated_at` | `timestamp with time zone` | NOT NULL default `now()` |

- **Primary key:** `PRIMARY KEY (id)`
- **Foreign keys:**
  - `FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE SET NULL`
- **Unique:**
  - `UNIQUE (signature)`
- **Checks:**
  - `CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text, 'suppressed_backfill'::text, 'skipped_no_group'::text])))`
- **Indexes:**
  - `CREATE INDEX idx_datatruck_document_deliveries_group ON public.datatruck_document_deliveries USING btree (group_id, created_at DESC)`
  - `CREATE INDEX idx_datatruck_document_deliveries_status ON public.datatruck_document_deliveries USING btree (status, created_at DESC)`

## dispatch_eta_global_settings

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL |
| `driver_interval_minutes` | `integer` | NOT NULL default `60` |
| `test_interval_minutes` | `integer` | NOT NULL default `60` |
| `updated_at` | `timestamp without time zone` | NOT NULL default `now()` |

- **Primary key:** `PRIMARY KEY (id)`
- **Checks:**
  - `CHECK ((((driver_interval_minutes >= 1) AND (driver_interval_minutes <= 1440)) AND ((test_interval_minutes >= 1) AND (test_interval_minutes <= 1440))))`
  - `CHECK ((id = 1))`

## dispatch_eta_updates

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('dispatch_eta_updates_id_seq'::regclass)` |
| `group_id` | `integer` | NOT NULL |
| `enabled` | `boolean` | NOT NULL default `false` |
| `target_mode` | `text` | NOT NULL default `'driver'::text` |
| `interval_minutes` | `integer` | NOT NULL default `60` |
| `next_run_at` | `timestamp without time zone` | null |
| `processing` | `boolean` | NOT NULL default `false` |
| `processing_started_at` | `timestamp without time zone` | null |
| `last_run_at` | `timestamp without time zone` | null |
| `last_status` | `text` | null |
| `last_error` | `text` | null |
| `last_pinned_signature` | `text` | null |
| `cached_pickup` | `text` | null |
| `cached_delivery` | `text` | null |
| `cached_destination_query` | `text` | null |
| `cached_context_json` | `jsonb` | null |
| `created_at` | `timestamp without time zone` | NOT NULL default `now()` |
| `updated_at` | `timestamp without time zone` | NOT NULL default `now()` |

- **Primary key:** `PRIMARY KEY (id)`
- **Foreign keys:**
  - `FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE`
- **Unique:**
  - `UNIQUE (group_id)`
- **Checks:**
  - `CHECK (((interval_minutes >= 1) AND (interval_minutes <= 1440)))`
  - `CHECK ((target_mode = ANY (ARRAY['driver'::text, 'test'::text])))`
- **Indexes:**
  - `CREATE INDEX idx_dispatch_eta_due ON public.dispatch_eta_updates USING btree (next_run_at) WHERE (enabled = true)`

## dispatch_team_drivers

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('dispatch_team_drivers_id_seq'::regclass)` |
| `team_id` | `integer` | NOT NULL |
| `driver_external_id` | `text` | null |
| `driver_normalized_name` | `text` | NOT NULL |
| `driver_name` | `text` | NOT NULL |
| `created_at` | `timestamp with time zone` | NOT NULL default `now()` |
| `driver_profile_id` | `integer` | null |
| `group_id` | `integer` | null |
| `unit_number` | `text` | null |
| `active` | `boolean` | NOT NULL default `true` |
| `needs_review` | `boolean` | NOT NULL default `false` |
| `updated_at` | `timestamp with time zone` | NOT NULL default `now()` |

- **Primary key:** `PRIMARY KEY (id)`
- **Foreign keys:**
  - `FOREIGN KEY (driver_profile_id) REFERENCES driver_profiles(id) ON DELETE SET NULL`
  - `FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE SET NULL`
  - `FOREIGN KEY (team_id) REFERENCES dispatch_teams(id) ON DELETE CASCADE`
- **Unique:**
  - `UNIQUE (team_id, driver_normalized_name)`
- **Indexes:**
  - `CREATE INDEX idx_dispatch_team_drivers_profile ON public.dispatch_team_drivers USING btree (driver_profile_id) WHERE (driver_profile_id IS NOT NULL)`
  - `CREATE INDEX idx_dispatch_team_drivers_team ON public.dispatch_team_drivers USING btree (team_id)`
  - `CREATE UNIQUE INDEX uniq_dispatch_active_driver_group ON public.dispatch_team_drivers USING btree (group_id) WHERE (active AND (group_id IS NOT NULL))`
  - `CREATE UNIQUE INDEX uniq_dispatch_active_driver_profile ON public.dispatch_team_drivers USING btree (driver_profile_id) WHERE (active AND (driver_profile_id IS NOT NULL))`

## dispatch_team_members

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('dispatch_team_members_id_seq'::regclass)` |
| `team_id` | `integer` | NOT NULL |
| `name` | `text` | null |
| `telegram_username` | `text` | null |
| `telegram_user_id` | `bigint` | null |
| `role` | `text` | null |
| `active` | `boolean` | NOT NULL default `true` |
| `created_at` | `timestamp with time zone` | NOT NULL default `now()` |
| `updated_at` | `timestamp with time zone` | NOT NULL default `now()` |

- **Primary key:** `PRIMARY KEY (id)`
- **Foreign keys:**
  - `FOREIGN KEY (team_id) REFERENCES dispatch_teams(id) ON DELETE CASCADE`
- **Checks:**
  - `CHECK (((role IS NULL) OR (role = ANY (ARRAY['dispatcher'::text, 'lead_dispatcher'::text, 'manager'::text]))))`
- **Indexes:**
  - `CREATE INDEX idx_dispatch_team_members_team ON public.dispatch_team_members USING btree (team_id)`
  - `CREATE INDEX idx_dispatch_team_members_user_id ON public.dispatch_team_members USING btree (telegram_user_id) WHERE (telegram_user_id IS NOT NULL)`
  - `CREATE INDEX idx_dispatch_team_members_username ON public.dispatch_team_members USING btree (telegram_username) WHERE (telegram_username IS NOT NULL)`

## dispatch_teams

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('dispatch_teams_id_seq'::regclass)` |
| `name` | `text` | NOT NULL |
| `active` | `boolean` | NOT NULL default `true` |
| `created_at` | `timestamp with time zone` | NOT NULL default `now()` |
| `updated_at` | `timestamp with time zone` | NOT NULL default `now()` |

- **Primary key:** `PRIMARY KEY (id)`

## driver_home_status

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `group_id` | `integer` | NOT NULL |
| `telegram_group_id` | `bigint` | null |
| `state` | `text` | NOT NULL |
| `state_since` | `timestamp with time zone` | NOT NULL |
| `last_status_text` | `text` | null |
| `last_status_at` | `timestamp with time zone` | NOT NULL |
| `road_bonus_weeks_notified` | `integer` | NOT NULL default `0` |
| `updated_at` | `timestamp with time zone` | NOT NULL default `now()` |

- **Primary key:** `PRIMARY KEY (group_id)`
- **Foreign keys:**
  - `FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE`
- **Checks:**
  - `CHECK ((state = ANY (ARRAY['home'::text, 'road'::text])))`

## driver_location_checkins

- **Status:** 🟡 legacy
- **Used by:** bot (check-in/out flow)
- **Purpose:** Driver location check-in records.
- **⚠️ Data-safety note:** Related to the retired check-in/check-out feature (see docs/architecture/retired-checkin-checkout-feature.md). Retained for history; verify usage before removing.

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('driver_location_checkins_id_seq'::regclass)` |
| `monitor_id` | `integer` | NOT NULL |
| `group_id` | `integer` | NOT NULL |
| `telegram_group_id` | `bigint` | NOT NULL |
| `order_id` | `text` | null |
| `stop_type` | `text` | NOT NULL |
| `location_address` | `text` | null |
| `appointment_at` | `timestamp with time zone` | null |
| `eta_at` | `timestamp with time zone` | null |
| `distance_miles_at_prompt` | `numeric` | null |
| `prompt_message_id` | `bigint` | null |
| `status` | `text` | NOT NULL default `'awaiting_response'::text` |
| `driver_response` | `text` | null |
| `responded_by_username` | `text` | null |
| `responded_by_user_id` | `bigint` | null |
| `responded_at` | `timestamp with time zone` | null |
| `on_time` | `boolean` | null |
| `created_at` | `timestamp with time zone` | NOT NULL default `now()` |
| `dedupe_key` | `text` | null |
| `checked_in_at` | `timestamp with time zone` | null |
| `checked_out_at` | `timestamp with time zone` | null |
| `checked_in_by_username` | `text` | null |
| `checked_in_by_user_id` | `bigint` | null |
| `checked_out_by_username` | `text` | null |
| `checked_out_by_user_id` | `bigint` | null |

- **Primary key:** `PRIMARY KEY (id)`
- **Foreign keys:**
  - `FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE`
  - `FOREIGN KEY (monitor_id) REFERENCES driver_location_monitors(id) ON DELETE CASCADE`
- **Checks:**
  - `CHECK (((driver_response IS NULL) OR (driver_response = ANY (ARRAY['yes'::text, 'no'::text, 'checked_in'::text, 'checked_out'::text]))))`
  - `CHECK ((status = ANY (ARRAY['awaiting_response'::text, 'answered'::text, 'checked_in'::text, 'completed'::text, 'expired'::text])))`
  - `CHECK ((stop_type = ANY (ARRAY['shipper'::text, 'receiver'::text])))`
- **Indexes:**
  - `CREATE INDEX idx_driver_location_checkins_group_created ON public.driver_location_checkins USING btree (group_id, created_at DESC)`
  - `CREATE INDEX idx_driver_location_checkins_monitor ON public.driver_location_checkins USING btree (monitor_id, created_at DESC)`
  - `CREATE UNIQUE INDEX idx_driver_location_checkins_stop_once ON public.driver_location_checkins USING btree (dedupe_key) WHERE (dedupe_key IS NOT NULL)`

## driver_location_monitors

- **Status:** 🟡 legacy
- **Used by:** bot (check-in/out flow)
- **Purpose:** Per-group location-monitor scheduler rows.
- **⚠️ Data-safety note:** Related to the retired check-in/check-out feature. Retained for history; verify usage before removing.

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('driver_location_monitors_id_seq'::regclass)` |
| `group_id` | `integer` | NOT NULL |
| `enabled` | `boolean` | NOT NULL default `false` |
| `interval_minutes` | `integer` | NOT NULL default `30` |
| `checkin_radius_miles` | `numeric` | NOT NULL default `8` |
| `next_run_at` | `timestamp without time zone` | null |
| `processing` | `boolean` | NOT NULL default `false` |
| `processing_started_at` | `timestamp without time zone` | null |
| `last_run_at` | `timestamp without time zone` | null |
| `last_status` | `text` | null |
| `last_error` | `text` | null |
| `current_order_id` | `text` | null |
| `load_phase` | `text` | null |
| `target_stop_type` | `text` | null |
| `target_address` | `text` | null |
| `target_lat` | `double precision` | null |
| `target_lng` | `double precision` | null |
| `target_appointment_at` | `timestamp with time zone` | null |
| `last_eta_minutes` | `integer` | null |
| `last_eta_at` | `timestamp with time zone` | null |
| `last_distance_miles` | `numeric` | null |
| `active_checkin_id` | `integer` | null |
| `cached_context_json` | `jsonb` | null |
| `created_at` | `timestamp without time zone` | NOT NULL default `now()` |
| `updated_at` | `timestamp without time zone` | NOT NULL default `now()` |

- **Primary key:** `PRIMARY KEY (id)`
- **Foreign keys:**
  - `FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE`
- **Unique:**
  - `UNIQUE (group_id)`
- **Checks:**
  - `CHECK (((interval_minutes >= 1) AND (interval_minutes <= 1440)))`
  - `CHECK (((load_phase IS NULL) OR (load_phase = ANY (ARRAY['heading_pickup'::text, 'heading_delivery'::text, 'unknown'::text]))))`
  - `CHECK (((checkin_radius_miles >= (1)::numeric) AND (checkin_radius_miles <= (100)::numeric)))`
  - `CHECK (((target_stop_type IS NULL) OR (target_stop_type = ANY (ARRAY['shipper'::text, 'receiver'::text]))))`
- **Indexes:**
  - `CREATE INDEX idx_driver_location_due ON public.driver_location_monitors USING btree (next_run_at) WHERE (enabled = true)`

## driver_profiles

- **Status:** 🟢 active
- **Used by:** bot, admin
- **Purpose:** Per-driver-group profile (one active profile per driver group).
- **⚠️ Data-safety note:** Contains driver PII.

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('driver_profiles_id_seq'::regclass)` |
| `group_id` | `integer` | NOT NULL |
| `first_name` | `text` | null |
| `last_name` | `text` | null |
| `secondary_first_name` | `text` | null |
| `secondary_last_name` | `text` | null |
| `first_name_source` | `text` | null |
| `last_name_source` | `text` | null |
| `secondary_first_name_source` | `text` | null |
| `secondary_last_name_source` | `text` | null |
| `driver_type` | `text` | null |
| `driver_type_source` | `text` | null |
| `status` | `text` | null default `'active'::text` |
| `unit_number` | `text` | null |
| `unit_number_source` | `text` | null |
| `language` | `character varying(5)` | null default `'en'::character varying` |
| `date_of_birth` | `date` | null |
| `date_of_start` | `date` | null |
| `needs_review` | `boolean` | null default `false` |
| `backfill_confidence` | `smallint` | null |
| `created_at` | `timestamp without time zone` | null default `now()` |
| `updated_at` | `timestamp without time zone` | null default `now()` |
| `telegram_username` | `text` | null |
| `telegram_user_id` | `bigint` | null |

- **Primary key:** `PRIMARY KEY (id)`
- **Foreign keys:**
  - `FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE`
- **Unique:**
  - `UNIQUE (group_id)`
- **Checks:**
  - `CHECK (((backfill_confidence IS NULL) OR ((backfill_confidence >= 0) AND (backfill_confidence <= 100))))`
  - `CHECK (((driver_type IS NULL) OR (driver_type = ANY (ARRAY['owner'::text, 'company_driver'::text]))))`
  - `CHECK (((language)::text = ANY ((ARRAY['en'::character varying, 'ru'::character varying, 'uz'::character varying])::text[])))`
  - `CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text])))`
- **Indexes:**
  - `CREATE UNIQUE INDEX idx_driver_profiles_group_id ON public.driver_profiles USING btree (group_id)`
  - `CREATE INDEX idx_driver_profiles_language ON public.driver_profiles USING btree (language)`
  - `CREATE INDEX idx_driver_profiles_needs_review ON public.driver_profiles USING btree (needs_review) WHERE (needs_review = true)`
  - `CREATE INDEX idx_driver_profiles_status ON public.driver_profiles USING btree (status)`
  - `CREATE INDEX idx_driver_profiles_unit_number ON public.driver_profiles USING btree (unit_number)`

## driver_road_history

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('driver_road_history_id_seq'::regclass)` |
| `group_id` | `integer` | NOT NULL |
| `driver_name` | `text` | null |
| `unit_number` | `text` | null |
| `road_started_at` | `timestamp with time zone` | NOT NULL |
| `home_arrived_at` | `timestamp with time zone` | NOT NULL |
| `days_on_road` | `integer` | NOT NULL |
| `exceeded_weeks` | `integer` | NOT NULL default `0` |
| `bonus_usd` | `numeric(10,2)` | NOT NULL default `0` |
| `bonus_posted_at` | `timestamp with time zone` | null |
| `recorded_at` | `timestamp with time zone` | NOT NULL default `now()` |

- **Primary key:** `PRIMARY KEY (id)`
- **Foreign keys:**
  - `FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE`
- **Indexes:**
  - `CREATE INDEX idx_driver_road_history_bonus ON public.driver_road_history USING btree (home_arrived_at DESC) WHERE (bonus_usd > (0)::numeric)`
  - `CREATE INDEX idx_driver_road_history_group ON public.driver_road_history USING btree (group_id, home_arrived_at DESC)`
  - `CREATE INDEX idx_driver_road_history_unposted ON public.driver_road_history USING btree (home_arrived_at) WHERE ((bonus_usd > (0)::numeric) AND (bonus_posted_at IS NULL))`

## drivers

- **Status:** 🟢 active
- **Used by:** bot, admin
- **Purpose:** Driver identity records keyed by Telegram user id.
- **⚠️ Data-safety note:** Contains driver PII. Do not delete; deletions cascade to responses.

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('drivers_id_seq'::regclass)` |
| `telegram_user_id` | `bigint` | NOT NULL |
| `username` | `text` | null |
| `first_name` | `text` | null |
| `last_name` | `text` | null |
| `created_at` | `timestamp without time zone` | null default `now()` |

- **Primary key:** `PRIMARY KEY (id)`
- **Unique:**
  - `UNIQUE (telegram_user_id)`

## duplicate_unit_reports

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('duplicate_unit_reports_id_seq'::regclass)` |
| `unit_number` | `text` | NOT NULL |
| `report_type` | `text` | NOT NULL |
| `group_ids` | `integer[]` | NOT NULL default `'{}'::integer[]` |
| `group_names` | `text[]` | NOT NULL default `'{}'::text[]` |
| `group_driver_name` | `text` | null |
| `provider` | `text` | null |
| `provider_driver_name` | `text` | null |
| `detail` | `text` | null |
| `severity` | `text` | NOT NULL default `'info'::text` |
| `status` | `text` | NOT NULL default `'open'::text` |
| `first_seen_at` | `timestamp with time zone` | NOT NULL default `now()` |
| `last_seen_at` | `timestamp with time zone` | NOT NULL default `now()` |
| `resolved_at` | `timestamp with time zone` | null |

- **Primary key:** `PRIMARY KEY (id)`
- **Unique:**
  - `UNIQUE (unit_number, report_type)`
- **Checks:**
  - `CHECK ((report_type = ANY (ARRAY['duplicate_unit'::text, 'name_mismatch'::text, 'ambiguous_match'::text])))`
  - `CHECK ((severity = ANY (ARRAY['info'::text, 'warning'::text, 'serious'::text])))`
  - `CHECK ((status = ANY (ARRAY['open'::text, 'resolved'::text])))`
- **Indexes:**
  - `CREATE INDEX idx_duplicate_unit_reports_open ON public.duplicate_unit_reports USING btree (status, last_seen_at DESC) WHERE (status = 'open'::text)`

## eld_settings

- **Status:** 🟢 active
- **Used by:** admin (Settings → Live Location), eld services
- **Purpose:** Single-row (id=1) ELD/telematics provider credentials (Samsara, Drive HoS, Factor, Leader). Secrets stored AES-256-GCM encrypted.

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL |
| `samsara_enabled` | `boolean` | NOT NULL default `true` |
| `samsara_api_key_encrypted` | `text` | null |
| `drivehos_provider_key_encrypted` | `text` | null |
| `drivehos_api_base` | `text` | NOT NULL default `'https://api.drivehos.app'::text` |
| `factor_enabled` | `boolean` | NOT NULL default `true` |
| `factor_company_key_encrypted` | `text` | null |
| `leader_enabled` | `boolean` | NOT NULL default `true` |
| `leader_company_key_encrypted` | `text` | null |
| `updated_at` | `timestamp with time zone` | NOT NULL default `now()` |

- **Primary key:** `PRIMARY KEY (id)`
- **Checks:**
  - `CHECK ((id = 1))`

## employee_birthday_settings

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL |
| `timezone` | `text` | NOT NULL default `'Asia/Tashkent'::text` |
| `send_hour` | `integer` | NOT NULL default `0` |
| `send_minute` | `integer` | NOT NULL default `0` |
| `ai_instructions` | `text` | NOT NULL default `'Write a warm, professional birthday message for office staff at Wenze. Be sincere and appreciative. Use different wording each time.'::text` |
| `fallback_template` | `text` | NOT NULL default `'🎉 <b>Happy Birthday!</b> 🎂

Today we celebrate: <b>{names}</b>!

Wishing you a fantastic day and a great year ahead!

— <i>Wenze Management</i>'::text` |
| `updated_at` | `timestamp with time zone` | NOT NULL default `now()` |

- **Primary key:** `PRIMARY KEY (id)`
- **Checks:**
  - `CHECK ((id = 1))`
  - `CHECK (((send_hour >= 0) AND (send_hour <= 23)))`
  - `CHECK (((send_minute >= 0) AND (send_minute <= 59)))`

## employee_birthdays

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('employee_birthdays_id_seq'::regclass)` |
| `first_name` | `text` | NOT NULL |
| `last_name` | `text` | NOT NULL |
| `birthday` | `date` | NOT NULL |
| `created_at` | `timestamp without time zone` | null default `now()` |

- **Primary key:** `PRIMARY KEY (id)`
- **Unique:**
  - `UNIQUE (first_name, last_name)`

## employee_votes

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('employee_votes_id_seq'::regclass)` |
| `poll_id` | `integer` | null |
| `option_id` | `integer` | null |
| `telegram_user_id` | `bigint` | NOT NULL |
| `telegram_username` | `text` | null |
| `telegram_first_name` | `text` | null |
| `unit_number` | `text` | NOT NULL |
| `created_at` | `timestamp without time zone` | null default `now()` |

- **Primary key:** `PRIMARY KEY (id)`
- **Foreign keys:**
  - `FOREIGN KEY (option_id) REFERENCES employee_votes_options(id) ON DELETE CASCADE`
  - `FOREIGN KEY (poll_id) REFERENCES employee_votes_polls(id) ON DELETE CASCADE`
- **Unique:**
  - `UNIQUE (poll_id, telegram_user_id)`
- **Indexes:**
  - `CREATE INDEX idx_employee_votes_option_id ON public.employee_votes USING btree (option_id)`

## employee_votes_options

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('employee_votes_options_id_seq'::regclass)` |
| `poll_id` | `integer` | null |
| `unit_number` | `text` | NOT NULL |
| `driver_name` | `text` | null |
| `company_name` | `text` | null |
| `driver_type` | `text` | null |
| `group_id` | `integer` | null |

- **Primary key:** `PRIMARY KEY (id)`
- **Foreign keys:**
  - `FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE SET NULL`
  - `FOREIGN KEY (poll_id) REFERENCES employee_votes_polls(id) ON DELETE CASCADE`
- **Indexes:**
  - `CREATE INDEX idx_employee_votes_options_group ON public.employee_votes_options USING btree (group_id)`
  - `CREATE INDEX idx_employee_votes_options_poll ON public.employee_votes_options USING btree (poll_id)`

## employee_votes_polls

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('employee_votes_polls_id_seq'::regclass)` |
| `question` | `text` | NOT NULL |
| `created_at` | `timestamp without time zone` | null default `now()` |
| `telegram_message_id` | `bigint` | null |
| `telegram_chat_id` | `bigint` | null |
| `status` | `text` | null default `'active'::text` |

- **Primary key:** `PRIMARY KEY (id)`

## facebook_connect_sessions

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('facebook_connect_sessions_id_seq'::regclass)` |
| `session_token` | `text` | NOT NULL |
| `group_id` | `integer` | NOT NULL |
| `telegram_group_id` | `bigint` | NOT NULL |
| `group_name` | `text` | null |
| `requested_by_telegram_user_id` | `bigint` | null |
| `requested_by_name` | `text` | null |
| `status` | `text` | NOT NULL default `'pending'::text` |
| `oauth_state` | `text` | null |
| `oauth_user_access_token_encrypted` | `text` | null |
| `oauth_user_id` | `text` | null |
| `oauth_user_name` | `text` | null |
| `expires_at` | `timestamp without time zone` | NOT NULL |
| `last_error` | `text` | null |
| `created_at` | `timestamp without time zone` | null default `now()` |
| `updated_at` | `timestamp without time zone` | null default `now()` |
| `completed_at` | `timestamp without time zone` | null |

- **Primary key:** `PRIMARY KEY (id)`
- **Foreign keys:**
  - `FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE`
- **Unique:**
  - `UNIQUE (oauth_state)`
  - `UNIQUE (session_token)`
- **Indexes:**
  - `CREATE INDEX idx_facebook_connect_sessions_expires ON public.facebook_connect_sessions USING btree (expires_at)`
  - `CREATE INDEX idx_facebook_connect_sessions_group ON public.facebook_connect_sessions USING btree (telegram_group_id, status)`

## facebook_lead_auto_message_rules

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('facebook_lead_auto_message_rules_id_seq'::regclass)` |
| `settings_id` | `integer` | NOT NULL |
| `label` | `text` | NOT NULL default `'Rule'::text` |
| `days_of_week` | `smallint[]` | NOT NULL default `'{1,2,3,4,5}'::smallint[]` |
| `start_time_local` | `time without time zone` | NOT NULL |
| `end_time_local` | `time without time zone` | NOT NULL |
| `message_template` | `text` | NOT NULL default `''::text` |
| `sort_order` | `integer` | NOT NULL default `0` |
| `is_active` | `boolean` | NOT NULL default `true` |
| `created_at` | `timestamp without time zone` | null default `now()` |
| `updated_at` | `timestamp without time zone` | null default `now()` |

- **Primary key:** `PRIMARY KEY (id)`
- **Foreign keys:**
  - `FOREIGN KEY (settings_id) REFERENCES facebook_lead_auto_message_settings(id) ON DELETE CASCADE`
- **Indexes:**
  - `CREATE INDEX idx_facebook_lead_auto_message_rules_settings ON public.facebook_lead_auto_message_rules USING btree (settings_id, sort_order, id)`

## facebook_lead_auto_message_settings

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('facebook_lead_auto_message_settings_id_seq'::regclass)` |
| `timezone` | `text` | NOT NULL default `'America/Chicago'::text` |
| `is_enabled` | `boolean` | NOT NULL default `true` |
| `rep_name` | `text` | NOT NULL default `'Tom'::text` |
| `company_name` | `text` | NOT NULL default `'Wenze trucking company'::text` |
| `position_label` | `text` | NOT NULL default `'OTR position'::text` |
| `fallback_template` | `text` | NOT NULL default `''::text` |
| `created_at` | `timestamp without time zone` | null default `now()` |
| `updated_at` | `timestamp without time zone` | null default `now()` |

- **Primary key:** `PRIMARY KEY (id)`

## facebook_lead_sms_mirrors

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('facebook_lead_sms_mirrors_id_seq'::regclass)` |
| `telegram_chat_id` | `bigint` | NOT NULL |
| `telegram_message_id` | `bigint` | NOT NULL |
| `driver_phone` | `text` | NOT NULL |
| `sms_body` | `text` | NOT NULL |
| `lead_name` | `text` | null |
| `page_id` | `text` | null |
| `rule_label` | `text` | null |
| `ringcentral_message_id` | `text` | null |
| `source_type` | `text` | NOT NULL default `'outbound_auto'::text` |
| `created_at` | `timestamp without time zone` | null default `now()` |

- **Primary key:** `PRIMARY KEY (id)`
- **Unique:**
  - `UNIQUE (telegram_chat_id, telegram_message_id)`
- **Indexes:**
  - `CREATE INDEX idx_facebook_lead_sms_mirrors_lookup ON public.facebook_lead_sms_mirrors USING btree (telegram_chat_id, telegram_message_id)`

## facebook_page_connections

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('facebook_page_connections_id_seq'::regclass)` |
| `group_id` | `integer` | NOT NULL |
| `telegram_group_id` | `bigint` | NOT NULL |
| `group_name` | `text` | null |
| `page_id` | `text` | NOT NULL |
| `page_name` | `text` | NOT NULL |
| `access_token_encrypted` | `text` | NOT NULL |
| `token_last4` | `text` | null |
| `connected_by_facebook_user_id` | `text` | null |
| `connected_by_facebook_user_name` | `text` | null |
| `granted_tasks` | `text[]` | null default `'{}'::text[]` |
| `granted_scopes` | `text[]` | null default `'{}'::text[]` |
| `subscribed_fields` | `text[]` | null default `'{}'::text[]` |
| `is_active` | `boolean` | NOT NULL default `true` |
| `last_subscription_status` | `text` | null |
| `last_error` | `text` | null |
| `connected_at` | `timestamp without time zone` | null default `now()` |
| `updated_at` | `timestamp without time zone` | null default `now()` |

- **Primary key:** `PRIMARY KEY (id)`
- **Foreign keys:**
  - `FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE`
- **Unique:**
  - `UNIQUE (page_id)`
- **Indexes:**
  - `CREATE INDEX idx_facebook_page_connections_group ON public.facebook_page_connections USING btree (telegram_group_id, is_active)`

## facebook_seen_senders

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `page_id` | `text` | NOT NULL |
| `sender_id` | `text` | NOT NULL |
| `first_event_key` | `text` | null |
| `created_at` | `timestamp without time zone` | null default `now()` |
| `updated_at` | `timestamp without time zone` | null default `now()` |

- **Primary key:** `PRIMARY KEY (page_id, sender_id)`

## facebook_webhook_events

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('facebook_webhook_events_id_seq'::regclass)` |
| `event_key` | `text` | NOT NULL |
| `page_id` | `text` | NOT NULL |
| `event_type` | `text` | NOT NULL |
| `payload` | `jsonb` | NOT NULL |
| `status` | `text` | NOT NULL default `'pending'::text` |
| `attempt_count` | `integer` | NOT NULL default `0` |
| `next_retry_at` | `timestamp without time zone` | NOT NULL default `now()` |
| `last_error` | `text` | null |
| `created_at` | `timestamp without time zone` | null default `now()` |
| `updated_at` | `timestamp without time zone` | null default `now()` |
| `processed_at` | `timestamp without time zone` | null |

- **Primary key:** `PRIMARY KEY (id)`
- **Unique:**
  - `UNIQUE (event_key)`
- **Indexes:**
  - `CREATE INDEX idx_facebook_webhook_events_page ON public.facebook_webhook_events USING btree (page_id, created_at DESC)`
  - `CREATE INDEX idx_facebook_webhook_events_status_retry ON public.facebook_webhook_events USING btree (status, next_retry_at, created_at)`

## fuel_monitor_inbox

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('fuel_monitor_inbox_id_seq'::regclass)` |
| `group_id` | `integer` | NOT NULL |
| `telegram_group_id` | `bigint` | NOT NULL |
| `message_id` | `bigint` | NOT NULL |
| `message_text` | `text` | NOT NULL |
| `status` | `text` | NOT NULL default `'pending'::text` |
| `alert_id` | `integer` | null |
| `created_at` | `timestamp without time zone` | NOT NULL default `now()` |
| `processed_at` | `timestamp without time zone` | null |

- **Primary key:** `PRIMARY KEY (id)`
- **Foreign keys:**
  - `FOREIGN KEY (alert_id) REFERENCES fuel_stop_alerts(id) ON DELETE SET NULL`
  - `FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE`
- **Unique:**
  - `UNIQUE (group_id, message_id)`
- **Checks:**
  - `CHECK ((status = ANY (ARRAY['pending'::text, 'picked_up'::text])))`
- **Indexes:**
  - `CREATE INDEX idx_fuel_monitor_inbox_alert_id ON public.fuel_monitor_inbox USING btree (alert_id)`
  - `CREATE INDEX idx_fuel_monitor_inbox_status_created ON public.fuel_monitor_inbox USING btree (status, created_at DESC)`

## fuel_stop_alerts

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('fuel_stop_alerts_id_seq'::regclass)` |
| `group_id` | `integer` | NOT NULL |
| `telegram_group_id` | `bigint` | NOT NULL |
| `source_message_id` | `bigint` | NOT NULL |
| `station_name` | `text` | null |
| `station_address` | `text` | null |
| `station_lat` | `double precision` | NOT NULL |
| `station_lng` | `double precision` | NOT NULL |
| `radius_miles` | `double precision` | NOT NULL default `10` |
| `status` | `text` | NOT NULL default `'watching'::text` |
| `processing` | `boolean` | NOT NULL default `false` |
| `processing_started_at` | `timestamp without time zone` | null |
| `last_distance_miles` | `double precision` | null |
| `last_checked_at` | `timestamp without time zone` | null |
| `notified_at` | `timestamp without time zone` | null |
| `last_error` | `text` | null |
| `created_at` | `timestamp without time zone` | NOT NULL default `now()` |
| `expires_at` | `timestamp without time zone` | null |
| `next_check_at` | `timestamp without time zone` | null |
| `eta_minutes` | `double precision` | null |
| `eta_boundary_at` | `timestamp without time zone` | null |

- **Primary key:** `PRIMARY KEY (id)`
- **Foreign keys:**
  - `FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE`
- **Checks:**
  - `CHECK ((status = ANY (ARRAY['watching'::text, 'notified'::text, 'expired'::text, 'error'::text])))`
- **Indexes:**
  - `CREATE INDEX idx_fuel_stop_alerts_due ON public.fuel_stop_alerts USING btree (status, expires_at)`
  - `CREATE INDEX idx_fuel_stop_alerts_group ON public.fuel_stop_alerts USING btree (group_id, created_at DESC)`
  - `CREATE INDEX idx_fuel_stop_alerts_next_check ON public.fuel_stop_alerts USING btree (status, next_check_at)`

## gmaps_settings

- **Status:** 🟢 active
- **Used by:** admin (Settings → GMaps), routeControlService
- **Purpose:** Single-row (id=1) Google Maps Platform config for Route Control. Server key encrypted at rest.

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL |
| `enabled` | `boolean` | NOT NULL default `false` |
| `server_api_key_encrypted` | `text` | null |
| `routes_api_enabled` | `boolean` | NOT NULL default `true` |
| `roads_api_enabled` | `boolean` | NOT NULL default `false` |
| `geocoding_api_enabled` | `boolean` | NOT NULL default `false` |
| `geocoding_api_key_encrypted` | `text` | null |
| `deviation_threshold_meters` | `integer` | NOT NULL default `250` |
| `check_interval_seconds` | `integer` | NOT NULL default `300` |
| `off_route_grace_checks` | `integer` | NOT NULL default `3` |
| `warning_cooldown_minutes` | `integer` | NOT NULL default `30` |
| `stale_gps_minutes` | `integer` | NOT NULL default `15` |
| `parked_speed_mph` | `integer` | NOT NULL default `5` |
| `updated_at` | `timestamp with time zone` | NOT NULL default `now()` |

- **Primary key:** `PRIMARY KEY (id)`
- **Checks:**
  - `CHECK (((check_interval_seconds >= 30) AND (check_interval_seconds <= 3600)))`
  - `CHECK (((deviation_threshold_meters >= 10) AND (deviation_threshold_meters <= 20000)))`
  - `CHECK ((id = 1))`
  - `CHECK (((off_route_grace_checks >= 1) AND (off_route_grace_checks <= 20)))`
  - `CHECK (((parked_speed_mph >= 0) AND (parked_speed_mph <= 60)))`
  - `CHECK (((stale_gps_minutes >= 1) AND (stale_gps_minutes <= 240)))`
  - `CHECK (((warning_cooldown_minutes >= 1) AND (warning_cooldown_minutes <= 1440)))`

## group_members

- **Status:** 🟢 active
- **Purpose:** which Telegram users the bot has SEEN in each group.

| Column | Type | Nullability |
|---|---|---|
| `group_id` | `integer` | NOT NULL |
| `telegram_user_id` | `bigint` | NOT NULL |
| `username` | `text` | null |
| `first_name` | `text` | null |
| `last_name` | `text` | null |
| `last_seen_at` | `timestamp with time zone` | null default `now()` |

- **Primary key:** `PRIMARY KEY (group_id, telegram_user_id)`
- **Foreign keys:**
  - `FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE`

## group_pinned_messages

- **Status:** 🟢 active
- **Purpose:** - Stores the latest pinned-message snapshot we observed in updates for each

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('group_pinned_messages_id_seq'::regclass)` |
| `group_id` | `integer` | NOT NULL |
| `telegram_group_id` | `bigint` | NOT NULL |
| `pinned_message_id` | `bigint` | NOT NULL |
| `pinned_message_json` | `jsonb` | NOT NULL |
| `source_event_message_id` | `bigint` | null |
| `source_event_at` | `timestamp without time zone` | null |
| `created_at` | `timestamp without time zone` | null default `now()` |
| `updated_at` | `timestamp without time zone` | null default `now()` |

- **Primary key:** `PRIMARY KEY (id)`
- **Foreign keys:**
  - `FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE`
- **Unique:**
  - `UNIQUE (group_id)`
- **Indexes:**
  - `CREATE UNIQUE INDEX idx_group_pinned_messages_group_id ON public.group_pinned_messages USING btree (group_id)`
  - `CREATE INDEX idx_group_pinned_messages_updated_at ON public.group_pinned_messages USING btree (updated_at DESC)`

## group_recent_loads

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('group_recent_loads_id_seq'::regclass)` |
| `group_id` | `integer` | NOT NULL |
| `telegram_message_id` | `bigint` | NOT NULL |
| `source_message_at` | `timestamp with time zone` | null |
| `context_signature` | `text` | NOT NULL |
| `pickup_summary` | `text` | NOT NULL default `''::text` |
| `delivery_summary` | `text` | NOT NULL default `''::text` |
| `destination_query` | `text` | NOT NULL default `''::text` |
| `pickup_window_start` | `timestamp with time zone` | null |
| `pickup_window_end` | `timestamp with time zone` | null |
| `delivery_window_start` | `timestamp with time zone` | null |
| `delivery_window_end` | `timestamp with time zone` | null |
| `load_identifier` | `text` | null |
| `caption_preview` | `text` | null |
| `extracted_raw_json` | `jsonb` | null |
| `ai_model` | `text` | null |
| `created_at` | `timestamp with time zone` | NOT NULL default `now()` |

- **Primary key:** `PRIMARY KEY (id)`
- **Foreign keys:**
  - `FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE`
- **Unique:**
  - `UNIQUE (group_id, telegram_message_id)`
- **Indexes:**
  - `CREATE INDEX idx_group_recent_loads_group_created ON public.group_recent_loads USING btree (group_id, created_at DESC)`

## groups

- **Status:** 🟢 active
- **Used by:** bot, admin, samsara-integration (read for routing)
- **Source of truth:** This table (mastered here).
- **Purpose:** Every Telegram group the bot manages — driver groups, dispatch/office groups, etc. Internal integer `id` is the FK target used everywhere; `telegram_group_id` (bigint) is the real Telegram chat id. `group_type='driver'` + a unit number in `group_name` is how the Samsara integration routes safety-event videos to the right driver group.
- **⚠️ Data-safety note:** Core table referenced by ~30 FKs. Never delete rows to 'clean up' — deactivate with active=false instead. Deleting a group cascades to its chat logs, members, driver profile, etc.

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('groups_id_seq'::regclass)` |
| `telegram_group_id` | `bigint` | NOT NULL |
| `group_name` | `text` | null |
| `language` | `character varying(5)` | null default `'en'::character varying` |
| `group_type` | `text` | null default `'driver'::text` |
| `created_at` | `timestamp without time zone` | null default `now()` |
| `active` | `boolean` | null default `true` |
| `driver_birthday` | `date` | null |
| `samsara_vehicle_id` | `text` | null |
| `status_source` | `text` | null |
| `status_updated_at` | `timestamp without time zone` | null |
| `last_message_seen_at` | `timestamp with time zone` | null |
| `bot_member_status` | `text` | null |
| `bot_access_checked_at` | `timestamp with time zone` | null |

- **Primary key:** `PRIMARY KEY (id)`
- **Unique:**
  - `UNIQUE (telegram_group_id)`
- **Indexes:**
  - `CREATE INDEX idx_groups_samsara_vehicle_id ON public.groups USING btree (samsara_vehicle_id) WHERE (samsara_vehicle_id IS NOT NULL)`
  - `CREATE INDEX idx_groups_type_active ON public.groups USING btree (group_type, active)`

## home_time_requests

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('home_time_requests_id_seq'::regclass)` |
| `group_id` | `integer` | null |
| `telegram_group_id` | `bigint` | null |
| `driver_name` | `text` | null |
| `unit_number` | `text` | null |
| `requested_by_user_id` | `bigint` | null |
| `requested_by_username` | `text` | null |
| `requested_at` | `timestamp with time zone` | NOT NULL default `now()` |
| `road_started_at` | `timestamp with time zone` | null |
| `days_on_road` | `integer` | null |
| `policy_met` | `boolean` | null |
| `home_from` | `date` | null |
| `home_to` | `date` | null |
| `status` | `text` | NOT NULL default `'pending'::text` |
| `source` | `text` | NOT NULL default `'telegram'::text` |
| `ai_reasoning` | `text` | null |
| `telegram_chat_id` | `bigint` | null |
| `telegram_message_id` | `bigint` | null |
| `decided_by_username` | `text` | null |
| `decided_by_user_id` | `bigint` | null |
| `decided_at` | `timestamp with time zone` | null |
| `created_at` | `timestamp with time zone` | NOT NULL default `now()` |

- **Primary key:** `PRIMARY KEY (id)`
- **Foreign keys:**
  - `FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE SET NULL`
- **Checks:**
  - `CHECK ((source = ANY (ARRAY['telegram'::text, 'manual'::text])))`
  - `CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'denied'::text, 'cancelled'::text, 'awaiting_dates'::text])))`
- **Indexes:**
  - `CREATE INDEX idx_home_time_requests_group ON public.home_time_requests USING btree (group_id, requested_at DESC)`
  - `CREATE INDEX idx_home_time_requests_status ON public.home_time_requests USING btree (status, requested_at DESC)`

## home_time_settings

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `1` |
| `enabled` | `boolean` | NOT NULL default `true` |
| `road_allowance_weeks` | `integer` | NOT NULL default `4` |
| `home_allowance_days` | `integer` | NOT NULL default `4` |
| `bonus_per_week` | `numeric(10,2)` | NOT NULL default `100` |
| `updated_at` | `timestamp with time zone` | NOT NULL default `now()` |

- **Primary key:** `PRIMARY KEY (id)`
- **Checks:**
  - `CHECK (((home_allowance_days >= 1) AND (home_allowance_days <= 60)))`
  - `CHECK ((id = 1))`
  - `CHECK (((road_allowance_weeks >= 1) AND (road_allowance_weeks <= 52)))`

## leads

- **Status:** 🟢 active
- **Used by:** leads services, admin
- **Purpose:** Recruiting leads ingested from external sources (Facebook, Indeed, Bitrix).

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('leads_id_seq'::regclass)` |
| `source` | `text` | NOT NULL |
| `external_id` | `text` | null |
| `full_name` | `text` | null |
| `email` | `text` | null |
| `phone` | `text` | null |
| `job_title` | `text` | null |
| `message` | `text` | null |
| `bitrix_id` | `text` | null |
| `bitrix_status` | `text` | null default `'pending'::text` |
| `raw` | `jsonb` | null |
| `created_at` | `timestamp without time zone` | null default `now()` |

- **Primary key:** `PRIMARY KEY (id)`
- **Unique:**
  - `UNIQUE (source, external_id)`
- **Indexes:**
  - `CREATE INDEX idx_leads_created_at ON public.leads USING btree (created_at DESC)`
  - `CREATE INDEX idx_leads_source_created ON public.leads USING btree (source, created_at DESC)`

## message_group_settings

- **Status:** 🟢 active
- **Used by:** admin (Settings → Telegram Groups), bonus/review senders
- **Purpose:** Single-row (id=1) map of message category → destination Telegram group id (stored as text). Telegram group ids are not secrets.

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL |
| `mileage_bonus_group_id` | `text` | null |
| `road_bonus_group_id` | `text` | null |
| `dispatch_review_group_id` | `text` | null |
| `updated_at` | `timestamp with time zone` | NOT NULL default `now()` |

- **Primary key:** `PRIMARY KEY (id)`
- **Checks:**
  - `CHECK ((id = 1))`

## mileage_bonus_notifications

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('mileage_bonus_notifications_id_seq'::regclass)` |
| `driver_external_id` | `text` | null |
| `driver_normalized_name` | `text` | NOT NULL |
| `driver_name` | `text` | NOT NULL |
| `threshold_miles` | `integer` | NOT NULL |
| `bonus_amount` | `integer` | NOT NULL |
| `miles_at_notification` | `numeric(12,2)` | NOT NULL |
| `period_start` | `date` | null |
| `period_end` | `date` | null |
| `trigger` | `text` | NOT NULL default `'scheduled'::text` |
| `status` | `text` | NOT NULL default `'pending'::text` |
| `telegram_chat_id` | `bigint` | null |
| `telegram_message_id` | `bigint` | null |
| `telegram_followup_message_id` | `bigint` | null |
| `decided_by_username` | `text` | null |
| `decided_by_user_id` | `bigint` | null |
| `decided_at` | `timestamp without time zone` | null |
| `disregarded_by_username` | `text` | null |
| `disregarded_at` | `timestamp with time zone` | null |
| `resend_count` | `integer` | NOT NULL default `0` |
| `last_resent_at` | `timestamp with time zone` | null |
| `last_resent_by_username` | `text` | null |
| `delivery_state` | `text` | NOT NULL default `'pending'::text` |
| `delivery_started_at` | `timestamp with time zone` | NOT NULL default `now()` |
| `action_state` | `text` | NOT NULL default `'idle'::text` |
| `action_started_at` | `timestamp with time zone` | null |
| `last_action_error` | `text` | null |
| `telegram_deleted_at` | `timestamp with time zone` | null |
| `telegram_delete_error` | `text` | null |
| `created_at` | `timestamp without time zone` | NOT NULL default `now()` |

- **Primary key:** `PRIMARY KEY (id)`
- **Unique:**
  - `UNIQUE (driver_normalized_name, threshold_miles)`
- **Checks:**
  - `CHECK ((action_state = ANY (ARRAY['idle'::text, 'resending'::text, 'disregarding'::text])))`
  - `CHECK ((delivery_state = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text])))`
  - `CHECK ((status = ANY (ARRAY['pending'::text, 'paid'::text, 'rejected'::text, 'disregarded'::text])))`
- **Indexes:**
  - `CREATE INDEX idx_mileage_bonus_notifications_created ON public.mileage_bonus_notifications USING btree (created_at DESC)`
  - `CREATE INDEX idx_mileage_bonus_notifications_status ON public.mileage_bonus_notifications USING btree (status)`

## mileage_bonus_progress

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('mileage_bonus_progress_id_seq'::regclass)` |
| `driver_external_id` | `text` | null |
| `driver_normalized_name` | `text` | NOT NULL |
| `driver_name` | `text` | NOT NULL |
| `driver_type` | `text` | null |
| `hire_date` | `date` | null |
| `period_start` | `date` | null |
| `period_end` | `date` | null |
| `total_miles` | `numeric(12,2)` | NOT NULL default `0` |
| `trips` | `integer` | NOT NULL default `0` |
| `highest_tier_reached` | `integer` | null |
| `next_tier` | `integer` | null |
| `miles_to_next_tier` | `numeric(12,2)` | null |
| `is_active` | `boolean` | NOT NULL default `true` |
| `activation_updated_at` | `timestamp with time zone` | null |
| `activation_updated_by` | `text` | null |
| `updated_at` | `timestamp without time zone` | NOT NULL default `now()` |

- **Primary key:** `PRIMARY KEY (id)`
- **Unique:**
  - `UNIQUE (driver_normalized_name)`
- **Indexes:**
  - `CREATE INDEX idx_mileage_bonus_progress_total ON public.mileage_bonus_progress USING btree (total_miles DESC)`

## mileage_bonus_runs

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `bigint` | NOT NULL default `nextval('mileage_bonus_runs_id_seq'::regclass)` |
| `run_key` | `text` | NOT NULL |
| `trigger` | `text` | NOT NULL |
| `mode` | `text` | NOT NULL |
| `status` | `text` | NOT NULL default `'running'::text` |
| `attempt_count` | `integer` | NOT NULL default `1` |
| `requested_by` | `text` | null |
| `started_at` | `timestamp with time zone` | NOT NULL default `now()` |
| `lease_expires_at` | `timestamp with time zone` | NOT NULL |
| `next_retry_at` | `timestamp with time zone` | null |
| `finished_at` | `timestamp with time zone` | null |
| `error` | `text` | null |
| `summary` | `jsonb` | null |

- **Primary key:** `PRIMARY KEY (id)`
- **Unique:**
  - `UNIQUE (run_key)`
- **Checks:**
  - `CHECK ((mode = ANY (ARRAY['notify'::text, 'refresh'::text])))`
  - `CHECK ((status = ANY (ARRAY['running'::text, 'succeeded'::text, 'failed'::text])))`
- **Indexes:**
  - `CREATE INDEX idx_mileage_bonus_runs_started ON public.mileage_bonus_runs USING btree (started_at DESC)`
  - `CREATE INDEX idx_mileage_bonus_runs_status ON public.mileage_bonus_runs USING btree (status, lease_expires_at, next_retry_at)`

## option_translations

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('option_translations_id_seq'::regclass)` |
| `option_id` | `integer` | null |
| `language` | `character varying(5)` | NOT NULL |
| `option_text` | `text` | NOT NULL |

- **Primary key:** `PRIMARY KEY (id)`
- **Foreign keys:**
  - `FOREIGN KEY (option_id) REFERENCES options(id) ON DELETE CASCADE`
- **Unique:**
  - `UNIQUE (option_id, language)`

## options

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('options_id_seq'::regclass)` |
| `question_id` | `integer` | null |
| `option_order` | `integer` | NOT NULL |

- **Primary key:** `PRIMARY KEY (id)`
- **Foreign keys:**
  - `FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE`
- **Indexes:**
  - `CREATE INDEX idx_options_question_id ON public.options USING btree (question_id)`

## question_media

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('question_media_id_seq'::regclass)` |
| `question_id` | `integer` | null |
| `file_id` | `text` | NOT NULL |
| `media_type` | `text` | NOT NULL |
| `sort_order` | `integer` | null default `0` |

- **Primary key:** `PRIMARY KEY (id)`
- **Foreign keys:**
  - `FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE`
- **Indexes:**
  - `CREATE INDEX idx_question_media_question_id ON public.question_media USING btree (question_id)`

## question_translations

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('question_translations_id_seq'::regclass)` |
| `question_id` | `integer` | null |
| `language` | `character varying(5)` | NOT NULL |
| `question_text` | `text` | NOT NULL |

- **Primary key:** `PRIMARY KEY (id)`
- **Foreign keys:**
  - `FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE`
- **Unique:**
  - `UNIQUE (question_id, language)`

## questions

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('questions_id_seq'::regclass)` |
| `created_at` | `timestamp without time zone` | null default `now()` |
| `active` | `boolean` | null default `true` |
| `media_position` | `text` | null default `'above'::text` |

- **Primary key:** `PRIMARY KEY (id)`

## raise_otp

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('raise_otp_id_seq'::regclass)` |
| `round_id` | `integer` | NOT NULL |
| `team_id` | `integer` | null |
| `contact` | `text` | NOT NULL |
| `contact_type` | `text` | NOT NULL |
| `code_hash` | `text` | NOT NULL |
| `expires_at` | `timestamp with time zone` | NOT NULL |
| `attempts` | `integer` | NOT NULL default `0` |
| `verified` | `boolean` | NOT NULL default `false` |
| `verified_at` | `timestamp with time zone` | null |
| `created_at` | `timestamp with time zone` | NOT NULL default `now()` |

- **Primary key:** `PRIMARY KEY (id)`
- **Foreign keys:**
  - `FOREIGN KEY (round_id) REFERENCES raise_rounds(id) ON DELETE CASCADE`
  - `FOREIGN KEY (team_id) REFERENCES dispatch_teams(id) ON DELETE SET NULL`
- **Checks:**
  - `CHECK ((contact_type = ANY (ARRAY['email'::text, 'phone'::text])))`
- **Indexes:**
  - `CREATE INDEX idx_raise_otp_lookup ON public.raise_otp USING btree (round_id, contact, created_at DESC)`
  - `CREATE INDEX idx_raise_otp_team_id ON public.raise_otp USING btree (team_id)`

## raise_round_picks

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('raise_round_picks_id_seq'::regclass)` |
| `submission_id` | `integer` | NOT NULL |
| `round_id` | `integer` | NOT NULL |
| `team_id` | `integer` | NOT NULL |
| `driver_normalized_name` | `text` | NOT NULL |
| `driver_name` | `text` | NOT NULL |
| `qualified` | `boolean` | NOT NULL |
| `created_at` | `timestamp with time zone` | NOT NULL default `now()` |

- **Primary key:** `PRIMARY KEY (id)`
- **Foreign keys:**
  - `FOREIGN KEY (round_id) REFERENCES raise_rounds(id) ON DELETE CASCADE`
  - `FOREIGN KEY (submission_id) REFERENCES raise_round_submissions(id) ON DELETE CASCADE`
  - `FOREIGN KEY (team_id) REFERENCES dispatch_teams(id) ON DELETE CASCADE`
- **Indexes:**
  - `CREATE INDEX idx_raise_round_picks_round ON public.raise_round_picks USING btree (round_id)`
  - `CREATE INDEX idx_raise_round_picks_submission ON public.raise_round_picks USING btree (submission_id)`
  - `CREATE INDEX idx_raise_round_picks_team ON public.raise_round_picks USING btree (team_id)`

## raise_round_submissions

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('raise_round_submissions_id_seq'::regclass)` |
| `round_id` | `integer` | NOT NULL |
| `team_id` | `integer` | NOT NULL |
| `dispatcher_name` | `text` | NOT NULL |
| `dispatcher_contact` | `text` | NOT NULL |
| `contact_type` | `text` | NOT NULL |
| `submitted_at` | `timestamp with time zone` | NOT NULL default `now()` |

- **Primary key:** `PRIMARY KEY (id)`
- **Foreign keys:**
  - `FOREIGN KEY (round_id) REFERENCES raise_rounds(id) ON DELETE CASCADE`
  - `FOREIGN KEY (team_id) REFERENCES dispatch_teams(id) ON DELETE CASCADE`
- **Unique:**
  - `UNIQUE (round_id, team_id)`
- **Checks:**
  - `CHECK ((contact_type = ANY (ARRAY['email'::text, 'phone'::text])))`
- **Indexes:**
  - `CREATE INDEX idx_raise_round_submissions_team ON public.raise_round_submissions USING btree (team_id)`

## raise_rounds

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('raise_rounds_id_seq'::regclass)` |
| `period_start` | `date` | NOT NULL |
| `period_end` | `date` | NOT NULL |
| `access_token` | `text` | NOT NULL |
| `status` | `text` | NOT NULL default `'open'::text` |
| `rate_low` | `numeric(5,3)` | NOT NULL default `0.720` |
| `rate_high` | `numeric(5,3)` | NOT NULL default `0.750` |
| `expires_at` | `timestamp with time zone` | NOT NULL |
| `employee_chat_id` | `text` | null |
| `employee_message_id` | `bigint` | null |
| `created_by` | `text` | null |
| `created_at` | `timestamp with time zone` | NOT NULL default `now()` |
| `closed_at` | `timestamp with time zone` | null |

- **Primary key:** `PRIMARY KEY (id)`
- **Unique:**
  - `UNIQUE (access_token)`
- **Checks:**
  - `CHECK ((status = ANY (ARRAY['open'::text, 'closed'::text])))`
- **Indexes:**
  - `CREATE INDEX idx_raise_rounds_status ON public.raise_rounds USING btree (status, created_at DESC)`

## raise_settings

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL |
| `enabled` | `boolean` | NOT NULL default `false` |
| `otp_channel` | `text` | NOT NULL default `'gmail'::text` |
| `schedule_enabled` | `boolean` | NOT NULL default `false` |
| `weekly_day_of_week` | `integer` | NOT NULL default `7` |
| `weekly_time_local` | `text` | NOT NULL default `'14:00'::text` |
| `schedule_timezone` | `text` | NOT NULL default `'America/Chicago'::text` |
| `rate_low` | `numeric(5,3)` | NOT NULL default `0.720` |
| `rate_high` | `numeric(5,3)` | NOT NULL default `0.750` |
| `link_ttl_hours` | `integer` | NOT NULL default `48` |
| `gmail_user` | `text` | null |
| `gmail_app_password_encrypted` | `text` | null |
| `next_run_at` | `timestamp with time zone` | null |
| `updated_at` | `timestamp with time zone` | NOT NULL default `now()` |

- **Primary key:** `PRIMARY KEY (id)`
- **Checks:**
  - `CHECK ((id = 1))`
  - `CHECK (((link_ttl_hours >= 1) AND (link_ttl_hours <= 720)))`
  - `CHECK ((otp_channel = ANY (ARRAY['gmail'::text, 'ringcentral'::text])))`
  - `CHECK (((weekly_day_of_week >= 1) AND (weekly_day_of_week <= 7)))`

## recruiters

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('recruiters_id_seq'::regclass)` |
| `name` | `text` | NOT NULL |
| `phone_number` | `text` | NOT NULL |
| `phone_number_normalized` | `text` | NOT NULL |
| `active` | `boolean` | NOT NULL default `true` |
| `jwt_token_encrypted` | `text` | null |
| `client_id_encrypted` | `text` | null |
| `client_secret_encrypted` | `text` | null |
| `created_at` | `timestamp with time zone` | NOT NULL default `now()` |
| `updated_at` | `timestamp with time zone` | NOT NULL default `now()` |

- **Primary key:** `PRIMARY KEY (id)`
- **Unique:**
  - `UNIQUE (phone_number_normalized)`

## responses

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('responses_id_seq'::regclass)` |
| `driver_id` | `integer` | null |
| `group_id` | `integer` | null |
| `question_id` | `integer` | null |
| `option_id` | `integer` | null |
| `answered_at` | `timestamp without time zone` | null default `now()` |

- **Primary key:** `PRIMARY KEY (id)`
- **Foreign keys:**
  - `FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE CASCADE`
  - `FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE`
  - `FOREIGN KEY (option_id) REFERENCES options(id) ON DELETE CASCADE`
  - `FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE`
- **Indexes:**
  - `CREATE INDEX idx_responses_answered_at ON public.responses USING btree (answered_at DESC)`
  - `CREATE INDEX idx_responses_group_id_answered_at ON public.responses USING btree (group_id, answered_at DESC)`
  - `CREATE INDEX idx_responses_option_id ON public.responses USING btree (option_id)`
  - `CREATE INDEX idx_responses_question_id ON public.responses USING btree (question_id)`
  - `CREATE UNIQUE INDEX idx_unique_driver_question ON public.responses USING btree (driver_id, question_id)`

## ringcentral_calls

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `text` | NOT NULL |
| `session_id` | `text` | null |
| `recruiter_id` | `integer` | null |
| `recruiter_number_normalized` | `text` | null |
| `direction` | `text` | null |
| `result` | `text` | null |
| `from_number` | `text` | null |
| `to_number` | `text` | null |
| `duration_seconds` | `integer` | NOT NULL default `0` |
| `call_time` | `timestamp with time zone` | NOT NULL |
| `created_at` | `timestamp with time zone` | NOT NULL default `now()` |

- **Primary key:** `PRIMARY KEY (id)`
- **Foreign keys:**
  - `FOREIGN KEY (recruiter_id) REFERENCES recruiters(id) ON DELETE SET NULL`
- **Indexes:**
  - `CREATE INDEX idx_ringcentral_calls_recruiter_time ON public.ringcentral_calls USING btree (recruiter_id, call_time DESC)`
  - `CREATE INDEX idx_ringcentral_calls_time ON public.ringcentral_calls USING btree (call_time DESC)`

## ringcentral_settings

- **Status:** 🟢 active
- **Used by:** admin (Settings → RingCentral), recruiterCallSyncService
- **Purpose:** Single-row (id=1) RingCentral call-KPI credentials + thresholds. Secrets encrypted.

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL |
| `enabled` | `boolean` | NOT NULL default `false` |
| `api_base` | `text` | NOT NULL default `'https://platform.ringcentral.com'::text` |
| `client_id_encrypted` | `text` | null |
| `client_secret_encrypted` | `text` | null |
| `jwt_token_encrypted` | `text` | null |
| `poll_minutes` | `integer` | NOT NULL default `10` |
| `timezone` | `text` | NOT NULL default `'America/Chicago'::text` |
| `non_valuable_max_seconds` | `integer` | NOT NULL default `30` |
| `real_conversation_min_seconds` | `integer` | NOT NULL default `60` |
| `strong_conversation_min_seconds` | `integer` | NOT NULL default `180` |
| `target_outbound` | `integer` | NOT NULL default `150` |
| `target_real_conversations` | `integer` | NOT NULL default `35` |
| `last_synced_at` | `timestamp with time zone` | null |
| `last_sync_error` | `text` | null |
| `updated_at` | `timestamp with time zone` | NOT NULL default `now()` |

- **Primary key:** `PRIMARY KEY (id)`
- **Checks:**
  - `CHECK ((id = 1))`
  - `CHECK (((poll_minutes >= 1) AND (poll_minutes <= 1440)))`

## route_assignments

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('route_assignments_id_seq'::regclass)` |
| `group_id` | `integer` | null |
| `driver_profile_id` | `integer` | null |
| `driver_label` | `text` | null |
| `unit_number` | `text` | null |
| `original_url` | `text` | NOT NULL |
| `origin_text` | `text` | null |
| `destination_text` | `text` | null |
| `waypoints` | `jsonb` | NOT NULL default `'[]'::jsonb` |
| `origin_lat` | `double precision` | null |
| `origin_lng` | `double precision` | null |
| `destination_lat` | `double precision` | null |
| `destination_lng` | `double precision` | null |
| `encoded_polyline` | `text` | null |
| `distance_meters` | `double precision` | null |
| `duration_seconds` | `double precision` | null |
| `status` | `text` | NOT NULL default `'active'::text` |
| `assigned_by` | `text` | null |
| `last_checked_at` | `timestamp with time zone` | null |
| `last_latitude` | `double precision` | null |
| `last_longitude` | `double precision` | null |
| `last_deviation_meters` | `double precision` | null |
| `last_check_result` | `text` | null |
| `consecutive_off_route` | `integer` | NOT NULL default `0` |
| `last_notification_at` | `timestamp with time zone` | null |
| `created_at` | `timestamp with time zone` | NOT NULL default `now()` |
| `updated_at` | `timestamp with time zone` | NOT NULL default `now()` |
| `source` | `text` | NOT NULL default `'admin'::text` |
| `assigned_by_user_id` | `bigint` | null |
| `telegram_chat_id` | `bigint` | null |
| `telegram_message_id` | `bigint` | null |

- **Primary key:** `PRIMARY KEY (id)`
- **Foreign keys:**
  - `FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE SET NULL`
- **Checks:**
  - `CHECK ((status = ANY (ARRAY['active'::text, 'completed'::text, 'cancelled'::text])))`
- **Indexes:**
  - `CREATE INDEX idx_route_assignments_active ON public.route_assignments USING btree (status, updated_at DESC) WHERE (status = 'active'::text)`
  - `CREATE INDEX idx_route_assignments_group ON public.route_assignments USING btree (group_id, created_at DESC)`
  - `CREATE UNIQUE INDEX uniq_route_assignments_telegram_message ON public.route_assignments USING btree (telegram_chat_id, telegram_message_id) WHERE ((telegram_chat_id IS NOT NULL) AND (telegram_message_id IS NOT NULL))`

## route_monitor_events

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('route_monitor_events_id_seq'::regclass)` |
| `assignment_id` | `integer` | NOT NULL |
| `event_type` | `text` | NOT NULL |
| `result` | `text` | null |
| `latitude` | `double precision` | null |
| `longitude` | `double precision` | null |
| `deviation_meters` | `double precision` | null |
| `detail` | `text` | null |
| `created_at` | `timestamp with time zone` | NOT NULL default `now()` |

- **Primary key:** `PRIMARY KEY (id)`
- **Foreign keys:**
  - `FOREIGN KEY (assignment_id) REFERENCES route_assignments(id) ON DELETE CASCADE`
- **Indexes:**
  - `CREATE INDEX idx_route_monitor_events_assignment ON public.route_monitor_events USING btree (assignment_id, created_at DESC)`

## safety_event_music_assets

- **Status:** 🟢 active
- **Used by:** admin (Settings → Safety Event Music, writes), samsara-integration (reads active clip bytes)
- **Source of truth:** This table (mastered by bot-backend).
- **Purpose:** Uploaded background-music clips for the driver-group speeding-video overlay. Bytes are stored in Postgres BYTEA (storage_kind='db_bytea') because the samsara-integration poller runs as a SEPARATE process with a DIFFERENT Telegram bot and Telegram file_ids are bot-scoped. Exactly one row is active at a time (partial unique index).
- **⚠️ Data-safety note:** Do not hard-delete the active clip — the app refuses it. Deactivate first. The BYTEA is the only copy of the uploaded music.

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('safety_event_music_assets_id_seq'::regclass)` |
| `name` | `text` | NOT NULL |
| `description` | `text` | null |
| `mime_type` | `text` | NOT NULL |
| `file_size_bytes` | `bigint` | NOT NULL |
| `duration_seconds` | `numeric(10,3)` | null |
| `storage_kind` | `text` | NOT NULL default `'db_bytea'::text` |
| `file_data` | `bytea` | null |
| `storage_path` | `text` | null |
| `checksum_sha256` | `text` | null |
| `is_active` | `boolean` | NOT NULL default `false` |
| `uploaded_by` | `text` | null |
| `created_at` | `timestamp with time zone` | NOT NULL default `now()` |
| `updated_at` | `timestamp with time zone` | NOT NULL default `now()` |

- **Primary key:** `PRIMARY KEY (id)`
- **Checks:**
  - `CHECK (((duration_seconds IS NULL) OR (duration_seconds >= (0)::numeric)))`
  - `CHECK ((file_size_bytes >= 0))`
  - `CHECK ((storage_kind = ANY (ARRAY['db_bytea'::text, 'filesystem'::text, 'object_storage'::text])))`
- **Indexes:**
  - `CREATE INDEX idx_safety_event_music_created ON public.safety_event_music_assets USING btree (created_at DESC)`
  - `CREATE UNIQUE INDEX uniq_safety_event_music_active ON public.safety_event_music_assets USING btree (is_active) WHERE is_active`

## safety_event_video_jobs

- **Status:** 🟢 active
- **Used by:** samsara-integration (writes), admin (future: read)
- **Purpose:** Best-effort observability ledger: one row per driver-group music-overlay attempt (pending→processing→sent/failed/fallback_sent/skipped). Written by the samsara-integration poller.
- **⚠️ Data-safety note:** Never store signed media URLs here — only an opaque/masked reference (video_reference).

| Column | Type | Nullability |
|---|---|---|
| `id` | `bigint` | NOT NULL default `nextval('safety_event_video_jobs_id_seq'::regclass)` |
| `samsara_event_id` | `text` | null |
| `telegram_group_id` | `bigint` | null |
| `music_asset_id` | `integer` | null |
| `status` | `text` | NOT NULL default `'pending'::text` |
| `video_source` | `text` | null |
| `video_reference` | `text` | null |
| `video_duration_seconds` | `numeric(10,3)` | null |
| `music_trim_mode` | `text` | null |
| `error_message` | `text` | null |
| `created_at` | `timestamp with time zone` | NOT NULL default `now()` |
| `started_at` | `timestamp with time zone` | null |
| `finished_at` | `timestamp with time zone` | null |

- **Primary key:** `PRIMARY KEY (id)`
- **Foreign keys:**
  - `FOREIGN KEY (music_asset_id) REFERENCES safety_event_music_assets(id) ON DELETE SET NULL`
- **Checks:**
  - `CHECK (((music_trim_mode IS NULL) OR (music_trim_mode = ANY (ARRAY['trim'::text, 'loop'::text, 'once'::text]))))`
  - `CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'sent'::text, 'failed'::text, 'fallback_sent'::text, 'skipped'::text])))`
  - `CHECK (((video_source IS NULL) OR (video_source = ANY (ARRAY['immediate'::text, 'backfill'::text]))))`
- **Indexes:**
  - `CREATE INDEX idx_safety_event_video_jobs_event ON public.safety_event_video_jobs USING btree (samsara_event_id)`
  - `CREATE INDEX idx_safety_event_video_jobs_status_created ON public.safety_event_video_jobs USING btree (status, created_at DESC)`

## safety_event_video_settings

- **Status:** 🟢 active
- **Used by:** admin (Settings → Safety Event Music, writes), samsara-integration (reads)
- **Purpose:** Single-row (id=1) config for the driver-group music overlay: enable flags, active music asset, volume, fades, mix-vs-replace, loop behaviour, and a max-video-length cap. `samsara_notification_group_original_video_enabled` documents (and never overrides) the invariant that the notifications group always gets the original video.

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL |
| `driver_group_music_enabled` | `boolean` | NOT NULL default `false` |
| `speeding_music_enabled` | `boolean` | NOT NULL default `true` |
| `active_music_asset_id` | `integer` | null |
| `samsara_notification_group_original_video_enabled` | `boolean` | NOT NULL default `true` |
| `music_volume` | `numeric(4,2)` | NOT NULL default `0.35` |
| `preserve_original_audio` | `boolean` | NOT NULL default `true` |
| `fade_in_seconds` | `numeric(5,2)` | NOT NULL default `0` |
| `fade_out_seconds` | `numeric(5,2)` | NOT NULL default `1.50` |
| `loop_music_when_video_longer` | `boolean` | NOT NULL default `true` |
| `max_video_seconds` | `integer` | NOT NULL default `120` |
| `updated_at` | `timestamp with time zone` | NOT NULL default `now()` |

- **Primary key:** `PRIMARY KEY (id)`
- **Foreign keys:**
  - `FOREIGN KEY (active_music_asset_id) REFERENCES safety_event_music_assets(id) ON DELETE SET NULL`
- **Checks:**
  - `CHECK (((fade_in_seconds >= (0)::numeric) AND (fade_in_seconds <= (60)::numeric)))`
  - `CHECK (((fade_out_seconds >= (0)::numeric) AND (fade_out_seconds <= (60)::numeric)))`
  - `CHECK ((id = 1))`
  - `CHECK (((max_video_seconds >= 0) AND (max_video_seconds <= 3600)))`
  - `CHECK (((music_volume >= (0)::numeric) AND (music_volume <= (2)::numeric)))`

## samsara_event_deliveries

- **Status:** 🟢 active
- **Used by:** samsara-integration (owns/creates this table)
- **Purpose:** Per-(event, target_chat_id) idempotent delivery ledger — the source of truth for 'already sent, do not resend'. status ∈ delivered|permanent; a delivered row is never downgraded.

| Column | Type | Nullability |
|---|---|---|
| `event_id` | `character varying(255)` | NOT NULL |
| `target_chat_id` | `character varying(255)` | NOT NULL |
| `status` | `character varying(32)` | NOT NULL default `'delivered'::character varying` |
| `updated_at` | `timestamp without time zone` | null default `now()` |

- **Primary key:** `PRIMARY KEY (event_id, target_chat_id)`

## samsara_poll_state

- **Status:** 🟢 active
- **Used by:** samsara-integration (owns/creates this table)
- **Purpose:** Key/value poll watermarks + pagination cursors for the two Samsara pollers.

| Column | Type | Nullability |
|---|---|---|
| `key` | `character varying(120)` | NOT NULL |
| `value` | `text` | null |
| `updated_at` | `timestamp without time zone` | null default `now()` |

- **Primary key:** `PRIMARY KEY (key)`

## samsara_processed_events

- **Status:** 🟢 active
- **Used by:** samsara-integration (owns/creates this table)
- **Source of truth:** samsara-integration.
- **Purpose:** Durable dedup set of Samsara safety/speeding event ids already handled, so restarts/redeploys never re-broadcast.

| Column | Type | Nullability |
|---|---|---|
| `id` | `character varying(255)` | NOT NULL |
| `processed_at` | `timestamp without time zone` | null default `now()` |

- **Primary key:** `PRIMARY KEY (id)`

## scheduled_messages

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('scheduled_messages_id_seq'::regclass)` |
| `message_text_en` | `text` | null |
| `message_text_ru` | `text` | null |
| `message_text_uz` | `text` | null |
| `media_items` | `jsonb` | null |
| `media_file_id` | `text` | null |
| `media_type` | `text` | null |
| `media_position` | `text` | null default `'above'::text` |
| `target_type` | `text` | null default `'all'::text` |
| `target_driver_ids` | `integer[]` | null |
| `target_languages` | `text[]` | null |
| `force_language` | `text` | null |
| `scheduled_at` | `timestamp without time zone` | NOT NULL |
| `schedule_type` | `text` | null default `'one_time'::text` |
| `schedule_timezone` | `text` | null default `'America/Chicago'::text` |
| `weekly_day_of_week` | `smallint` | null |
| `weekly_time_local` | `text` | null |
| `last_sent_at` | `timestamp without time zone` | null |
| `last_run_status` | `text` | null |
| `status` | `text` | null default `'pending'::text` |
| `created_at` | `timestamp without time zone` | null default `now()` |
| `target_active_filter` | `text` | null |

- **Primary key:** `PRIMARY KEY (id)`
- **Checks:**
  - `CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'sent'::text, 'failed'::text, 'cancelled'::text])))`
- **Indexes:**
  - `CREATE INDEX idx_scheduled_messages_pending_due ON public.scheduled_messages USING btree (scheduled_at) WHERE (status = 'pending'::text)`

## sender_role_consensus

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `group_id` | `integer` | NOT NULL |
| `telegram_user_id` | `bigint` | NOT NULL |
| `sender_name` | `text` | null |
| `role` | `character varying(16)` | null |
| `confidence` | `smallint` | null |
| `message_count` | `integer` | null |
| `last_updated` | `timestamp without time zone` | null default `now()` |

- **Primary key:** `PRIMARY KEY (group_id, telegram_user_id)`
- **Foreign keys:**
  - `FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE`

## service_runs

- **Status:** 🟢 active
- **Purpose:** _No description recorded._

| Column | Type | Nullability |
|---|---|---|
| `id` | `integer` | NOT NULL default `nextval('service_runs_id_seq'::regclass)` |
| `service_name` | `text` | NOT NULL |
| `run_key` | `text` | NOT NULL |
| `ran_at` | `timestamp without time zone` | NOT NULL default `now()` |

- **Primary key:** `PRIMARY KEY (id)`
- **Unique:**
  - `UNIQUE (service_name, run_key)`
- **Indexes:**
  - `CREATE INDEX idx_service_runs_ran_at ON public.service_runs USING btree (ran_at DESC)`

