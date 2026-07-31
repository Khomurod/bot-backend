-- Migration 0005: qbq presentation edits
-- migrate:kind: schema
--
-- Durable storage for the SOS/QBQ presentation hosted at /qbq.
--
-- The uploaded deck ("SOS Prezentatsiya (offline v2) (1).html") stays the
-- immutable SOURCE TEMPLATE on disk. This table stores only per-element TEXT
-- OVERRIDES on top of it, so the document itself is never rewritten into the
-- database and a bad edit can never corrupt the deck.
--
--   * deck_key      — which deck the override belongs to. One deck today
--                     ('sos-offline-v2'); the column exists so a second deck
--                     can be hosted later without a schema change.
--   * element_path  — a stable structural address of the edited element,
--                     'sSLIDE.CHILD[.CHILD...]' (e.g. 's11.0.2'): the slide's
--                     position among deck slides, then the element-child chain
--                     down to the target. Validated in
--                     services/qbq/elementPath.js before it ever reaches SQL.
--   * content       — PLAIN TEXT ONLY. services/qbq/sanitizeEditableText.js
--                     strips every tag and control character before the write,
--                     and the client re-applies it with textContent plus real
--                     <br> nodes, never innerHTML. No markup round-trips
--                     through this column, so a stored value cannot carry
--                     script, attributes or event handlers.
--
-- The UNIQUE index is what makes saving a single atomic UPSERT (see
-- database/qbqPresentation.js). There is deliberately no delete-then-insert
-- path: a failed save leaves the previously saved row untouched.
--
-- This data is intentionally ISOLATED from the SOS questionnaire tables
-- (sos_submissions, sos_settings) — presentation edits and assessment results
-- never share a table, a key, or a query.
--
-- Additive and idempotent (IF NOT EXISTS throughout), so re-running it on every
-- boot is a strict no-op. Review the full diff before pushing — this repo can
-- auto-deploy. See database/migrations/README.md.

CREATE TABLE IF NOT EXISTS qbq_presentation_edits (
  id                  BIGSERIAL PRIMARY KEY,
  deck_key            TEXT NOT NULL DEFAULT 'sos-offline-v2',
  element_path        TEXT NOT NULL,
  slide_index         INTEGER NOT NULL,
  content             TEXT NOT NULL,
  updated_by_admin_id INTEGER,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per (deck, element). This index is required by the ON CONFLICT
-- target in upsertOverride(); dropping it would silently turn every save into
-- a duplicate insert.
CREATE UNIQUE INDEX IF NOT EXISTS uq_qbq_presentation_edits_key_path
  ON qbq_presentation_edits (deck_key, element_path);

-- Page render reads every override for one deck ordered by slide.
CREATE INDEX IF NOT EXISTS idx_qbq_presentation_edits_deck_slide
  ON qbq_presentation_edits (deck_key, slide_index);
