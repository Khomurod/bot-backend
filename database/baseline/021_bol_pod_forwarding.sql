-- ══════════════════════════════════════════════════════════════════════════
-- BOL / POD document forwarding (admin-controlled) — Settings → BOL / POD
-- ══════════════════════════════════════════════════════════════════════════
-- Runtime-editable routing for forwarding DataTruck BOL/POD documents to
-- Telegram groups. Single-row (id = 1). OFF by default: after deploy NO document
-- is forwarded to ANY group until an administrator enables the feature in the
-- admin panel. This is a NEW table — the retired bol_pod_monitor_settings table
-- (a different, removed feature) is left untouched for historical safety and is
-- NOT reused. No secrets are stored here (the bot token stays server-side).
CREATE TABLE IF NOT EXISTS bol_pod_forwarding_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  delivery_mode TEXT NOT NULL DEFAULT 'driver_group'
    CHECK (delivery_mode IN ('driver_group', 'central_group', 'both')),
  central_group_id BIGINT NULL,
  central_group_title TEXT NULL,
  central_group_validated_at TIMESTAMPTZ NULL,
  document_type_mode TEXT NOT NULL DEFAULT 'both'
    CHECK (document_type_mode IN ('bol', 'pod', 'both')),
  uncertain_document_policy TEXT NOT NULL DEFAULT 'do_not_send'
    CHECK (uncertain_document_policy IN ('do_not_send', 'central_review')),
  last_tested_at TIMESTAMPTZ NULL,
  updated_by TEXT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO bol_pod_forwarding_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
