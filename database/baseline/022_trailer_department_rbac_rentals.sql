-- =============================================================================
-- TRAILER DEPARTMENT: RENTAL + ASSET MANAGEMENT
-- Additive/idempotent. Existing trailer tracking/event history is preserved.
-- =============================================================================

-- Admin account lifecycle and database-backed RBAC.
ALTER TABLE admins ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ NULL;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE admins ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS created_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS updated_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS permissions (
  id SERIAL PRIMARY KEY,
  permission_key TEXT UNIQUE NOT NULL,
  description TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS roles (
  id SERIAL PRIMARY KEY,
  system_key TEXT UNIQUE NULL,
  display_name TEXT UNIQUE NOT NULL,
  description TEXT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  updated_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_user_roles (
  admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  assigned_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (admin_id, role_id)
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  granted_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (role_id, permission_id)
);

INSERT INTO roles (system_key, display_name, description) VALUES
  ('super_admin', 'Super Administrator', 'All application permissions'),
  ('trailer_manager', 'Trailer Manager', 'Full Trailer Department management'),
  ('trailer_employee', 'Trailer Employee', 'Daily trailer rental operations'),
  ('trailer_accounting', 'Trailer Accounting', 'Trailer invoices, payments and reports'),
  ('trailer_viewer', 'Trailer Viewer', 'Read-only Trailer Department access')
ON CONFLICT (system_key) DO NOTHING;

INSERT INTO permissions (permission_key, description) VALUES
  ('admin.full_access', 'Access legacy and company-wide administration'),
  ('users.manage', 'Manage administrator accounts'),
  ('roles.manage', 'Manage roles and permissions'),
  ('trailers.view', 'View trailer records'),
  ('trailers.create', 'Create trailer records'),
  ('trailers.edit', 'Edit trailer records'),
  ('trailers.delete_or_archive', 'Archive trailer records'),
  ('trailer_rentals.view', 'View trailer rentals'),
  ('trailer_rentals.create', 'Create trailer rentals'),
  ('trailer_rentals.edit', 'Edit trailer rentals'),
  ('trailer_rentals.close', 'Return and close trailer rentals'),
  ('trailer_companies.manage', 'Manage renter companies'),
  ('trailer_inspections.manage', 'Manage inspections and condition media'),
  ('trailer_payments.view', 'View trailer invoices and payments'),
  ('trailer_payments.record', 'Record trailer payments'),
  ('trailer_payments.record_without_receipt', 'Record a payment without a receipt and with a reason'),
  ('trailer_payments.reverse', 'Reverse trailer payments'),
  ('trailer_receipts.view', 'View payment receipts'),
  ('trailer_reports.view', 'View and export trailer reports'),
  ('trailer_settings.manage', 'Manage trailer settings and Telegram delivery'),
  ('trailer_users.manage', 'Manage Trailer Department users'),
  ('trailer_map.view', 'View the trailer-only map')
ON CONFLICT (permission_key) DO NOTHING;

-- Super administrators receive every permission. Existing admins retain their
-- former full access. System role display names remain editable; system_key is
-- the stable authorization identifier.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.system_key = 'super_admin'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.system_key = 'trailer_manager'
  AND (p.permission_key LIKE 'trailer%' OR p.permission_key LIKE 'trailers.%')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.system_key = 'trailer_employee'
  AND p.permission_key IN (
    'trailers.view','trailers.create','trailers.edit','trailer_rentals.view',
    'trailer_rentals.create','trailer_rentals.edit','trailer_rentals.close',
    'trailer_companies.manage','trailer_inspections.manage','trailer_payments.view',
    'trailer_payments.record','trailer_receipts.view','trailer_map.view'
  )
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.system_key = 'trailer_accounting'
  AND p.permission_key IN (
    'trailers.view','trailer_rentals.view','trailer_payments.view',
    'trailer_payments.record','trailer_payments.reverse',
    'trailer_payments.record_without_receipt','trailer_receipts.view',
    'trailer_reports.view'
  )
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.system_key = 'trailer_viewer'
  AND p.permission_key IN (
    'trailers.view','trailer_rentals.view','trailer_payments.view',
    'trailer_receipts.view','trailer_reports.view','trailer_map.view'
  )
ON CONFLICT DO NOTHING;

INSERT INTO admin_user_roles (admin_id, role_id)
SELECT a.id, r.id FROM admins a JOIN roles r ON r.system_key = 'super_admin'
WHERE NOT EXISTS (SELECT 1 FROM admin_user_roles aur WHERE aur.admin_id = a.id)
ON CONFLICT DO NOTHING;

-- Required operator login. This is a salted bcrypt cost-12 hash only; the seed
-- never updates an existing account and therefore never resets a changed password.
INSERT INTO admins (username, password_hash, active)
VALUES ('Trailer', '$2a$12$GuO8j3DGuDzHA7oo9d2IiO8F.3KEAjyRh0OA7CIPZk/wxxQS1nTdu', TRUE)
ON CONFLICT (username) DO NOTHING;
INSERT INTO admin_user_roles (admin_id, role_id)
SELECT a.id, r.id FROM admins a JOIN roles r ON r.system_key = 'trailer_manager'
WHERE a.username = 'Trailer'
ON CONFLICT DO NOTHING;

-- Trailer master additions. Existing records remain unknown/unreviewed until an
-- employee verifies physical availability; Telegram possession/cargo is separate.
ALTER TABLE trailers ADD COLUMN IF NOT EXISTS physical_status TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE trailers ADD COLUMN IF NOT EXISTS tracking_reference TEXT NULL;
ALTER TABLE trailers ADD COLUMN IF NOT EXISTS notes TEXT NULL;
ALTER TABLE trailers ADD COLUMN IF NOT EXISTS created_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE trailers ADD COLUMN IF NOT EXISTS updated_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL;
UPDATE trailers SET needs_review = TRUE WHERE physical_status = 'unknown';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trailers_physical_status_check') THEN
    ALTER TABLE trailers ADD CONSTRAINT trailers_physical_status_check CHECK (
      physical_status IN ('unknown','available','rented','under_inspection','maintenance','out_of_service','held_damage')
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS trailer_renter_companies (
  id BIGSERIAL PRIMARY KEY,
  legal_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  mc_number TEXT NULL,
  dot_number TEXT NULL,
  billing_address TEXT NULL,
  contact_name TEXT NULL,
  phone TEXT NULL,
  email TEXT NULL,
  telegram_username TEXT NULL,
  telegram_user_id TEXT NULL,
  payment_terms TEXT NULL,
  default_currency TEXT NOT NULL DEFAULT 'USD' CHECK (default_currency = 'USD'),
  default_daily_rate NUMERIC(14,2) NULL,
  tax_reference TEXT NULL,
  notes TEXT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  updated_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trailer_companies_active_name ON trailer_renter_companies(active, display_name);

CREATE TABLE IF NOT EXISTS trailer_rentals (
  id BIGSERIAL PRIMARY KEY,
  agreement_number TEXT UNIQUE NOT NULL,
  trailer_id INTEGER NOT NULL REFERENCES trailers(id) ON DELETE RESTRICT,
  company_id BIGINT NOT NULL REFERENCES trailer_renter_companies(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','active','returned','closed','cancelled','disputed')),
  start_at TIMESTAMPTZ NULL,
  expected_return_at TIMESTAMPTZ NULL,
  actual_return_at TIMESTAMPTZ NULL,
  billing_method TEXT NOT NULL DEFAULT 'calendar_day' CHECK (billing_method IN ('calendar_day','twenty_four_hour','manual_days','flat_rate')),
  daily_rate NUMERIC(14,2) NULL,
  flat_rate NUMERIC(14,2) NULL,
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  deposit_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  discount_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  late_fee_rule JSONB NULL,
  grace_period_days INTEGER NOT NULL DEFAULT 0,
  payment_due_at TIMESTAMPTZ NULL,
  payment_terms TEXT NULL,
  pickup_location TEXT NULL,
  pickup_lat DOUBLE PRECISION NULL,
  pickup_lng DOUBLE PRECISION NULL,
  return_location TEXT NULL,
  return_lat DOUBLE PRECISION NULL,
  return_lng DOUBLE PRECISION NULL,
  current_reported_location TEXT NULL,
  manual_billable_days INTEGER NULL,
  manual_days_reason TEXT NULL,
  manual_days_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  manual_days_recorded_at TIMESTAMPTZ NULL,
  billable_days INTEGER NULL,
  elapsed_days NUMERIC(12,4) NULL,
  notes TEXT NULL,
  agreement_media_id BIGINT NULL,
  created_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  updated_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  closed_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ NULL,
  CHECK (status NOT IN ('scheduled','active') OR (start_at IS NOT NULL AND expected_return_at IS NOT NULL AND expected_return_at > start_at)),
  CHECK (billing_method <> 'manual_days' OR status = 'draft' OR (manual_billable_days > 0 AND manual_days_reason IS NOT NULL)),
  CHECK (billing_method <> 'flat_rate' OR flat_rate IS NOT NULL),
  CHECK (billing_method IN ('flat_rate') OR daily_rate IS NOT NULL OR status = 'draft')
);
CREATE INDEX IF NOT EXISTS idx_trailer_rentals_trailer_status ON trailer_rentals(trailer_id, status);
CREATE INDEX IF NOT EXISTS idx_trailer_rentals_company_status ON trailer_rentals(company_id, status);
CREATE INDEX IF NOT EXISTS idx_trailer_rentals_dates ON trailer_rentals(start_at, expected_return_at);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_trailer_one_active_rental ON trailer_rentals(trailer_id) WHERE status = 'active';

CREATE EXTENSION IF NOT EXISTS btree_gist;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trailer_rentals_no_scheduled_overlap') THEN
    ALTER TABLE trailer_rentals ADD CONSTRAINT trailer_rentals_no_scheduled_overlap
      EXCLUDE USING gist (
        trailer_id WITH =,
        tstzrange(start_at, expected_return_at, '[)') WITH &&
      ) WHERE (status IN ('scheduled','active'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS trailer_inspections (
  id BIGSERIAL PRIMARY KEY,
  rental_id BIGINT NOT NULL REFERENCES trailer_rentals(id) ON DELETE RESTRICT,
  trailer_id INTEGER NOT NULL REFERENCES trailers(id) ON DELETE RESTRICT,
  inspection_type TEXT NOT NULL CHECK (inspection_type IN ('pickup','return','damage','maintenance')),
  overall_condition TEXT NULL,
  tires TEXT NULL, lights TEXT NULL, doors TEXT NULL, roof TEXT NULL,
  floor TEXT NULL, exterior TEXT NULL, interior TEXT NULL,
  landing_gear TEXT NULL, brakes TEXT NULL, existing_damage TEXT NULL,
  new_damage TEXT NULL, missing_equipment TEXT NULL, notes TEXT NULL,
  inspector_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  inspected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (rental_id, inspection_type)
);

CREATE TABLE IF NOT EXISTS trailer_rental_movements (
  id BIGSERIAL PRIMARY KEY,
  trailer_id INTEGER NOT NULL REFERENCES trailers(id) ON DELETE RESTRICT,
  rental_id BIGINT NULL REFERENCES trailer_rentals(id) ON DELETE RESTRICT,
  movement_type TEXT NOT NULL CHECK (movement_type IN ('rental_pickup','rental_return','relocation','company_transfer','maintenance_move','manual_correction')),
  from_location TEXT NULL, to_location TEXT NULL,
  from_lat DOUBLE PRECISION NULL, from_lng DOUBLE PRECISION NULL,
  to_lat DOUBLE PRECISION NULL, to_lng DOUBLE PRECISION NULL,
  event_at TIMESTAMPTZ NOT NULL,
  employee_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT 'rental_manual',
  notes TEXT NULL,
  inspection_id BIGINT NULL REFERENCES trailer_inspections(id) ON DELETE SET NULL,
  trailer_event_id BIGINT NULL REFERENCES trailer_events(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trailer_movements_trailer_time ON trailer_rental_movements(trailer_id, event_at DESC);
CREATE INDEX IF NOT EXISTS idx_trailer_movements_rental ON trailer_rental_movements(rental_id);

CREATE TABLE IF NOT EXISTS trailer_media (
  id BIGSERIAL PRIMARY KEY,
  media_type TEXT NOT NULL CHECK (media_type IN ('pickup_condition_photo','return_condition_photo','damage_photo','payment_receipt','agreement_document','invoice_document','other_rental_document')),
  trailer_id INTEGER NULL REFERENCES trailers(id) ON DELETE RESTRICT,
  rental_id BIGINT NULL REFERENCES trailer_rentals(id) ON DELETE RESTRICT,
  inspection_id BIGINT NULL REFERENCES trailer_inspections(id) ON DELETE RESTRICT,
  invoice_id BIGINT NULL,
  payment_id BIGINT NULL,
  bucket TEXT NOT NULL,
  object_path TEXT NOT NULL,
  preview_object_path TEXT NULL,
  original_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  original_size_bytes BIGINT NOT NULL,
  compressed_size_bytes BIGINT NULL,
  checksum_sha256 TEXT NOT NULL,
  uploaded_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  notes TEXT NULL,
  superseded_by_media_id BIGINT NULL REFERENCES trailer_media(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (bucket, object_path)
);
CREATE INDEX IF NOT EXISTS idx_trailer_media_rental ON trailer_media(rental_id, media_type);

CREATE TABLE IF NOT EXISTS trailer_invoices (
  id BIGSERIAL PRIMARY KEY,
  invoice_number TEXT UNIQUE NOT NULL,
  rental_id BIGINT NOT NULL REFERENCES trailer_rentals(id) ON DELETE RESTRICT,
  trailer_id INTEGER NOT NULL REFERENCES trailers(id) ON DELETE RESTRICT,
  company_id BIGINT NOT NULL REFERENCES trailer_renter_companies(id) ON DELETE RESTRICT,
  billing_period_start TIMESTAMPTZ NOT NULL,
  billing_period_end TIMESTAMPTZ NOT NULL,
  billing_method TEXT NOT NULL,
  billable_days INTEGER NULL,
  daily_rate NUMERIC(14,2) NULL,
  flat_rate NUMERIC(14,2) NULL,
  base_amount NUMERIC(14,2) NOT NULL,
  deposit_credit NUMERIC(14,2) NOT NULL DEFAULT 0,
  discount_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  damage_charge NUMERIC(14,2) NOT NULL DEFAULT 0,
  cleaning_charge NUMERIC(14,2) NOT NULL DEFAULT 0,
  late_fee NUMERIC(14,2) NOT NULL DEFAULT 0,
  other_charges NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_amount NUMERIC(14,2) NOT NULL,
  late_fee_rule JSONB NULL,
  grace_period_days INTEGER NOT NULL DEFAULT 0,
  calculation_inputs JSONB NOT NULL DEFAULT '{}'::jsonb,
  due_at TIMESTAMPTZ NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','partially_paid','paid','overdue','disputed','voided')),
  reminder_state TEXT NOT NULL DEFAULT 'active' CHECK (reminder_state IN ('active','paused','snoozed','waived')),
  snoozed_until TIMESTAMPTZ NULL,
  notes TEXT NULL,
  created_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  finalized_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finalized_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trailer_invoices_due_status ON trailer_invoices(due_at, status);
CREATE INDEX IF NOT EXISTS idx_trailer_invoices_company ON trailer_invoices(company_id, created_at DESC);

-- Idempotent additions for databases where these tables predate this section.
ALTER TABLE trailer_rentals ADD COLUMN IF NOT EXISTS manual_days_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE trailer_rentals ADD COLUMN IF NOT EXISTS manual_days_recorded_at TIMESTAMPTZ NULL;
ALTER TABLE trailer_invoices ADD COLUMN IF NOT EXISTS late_fee_rule JSONB NULL;
ALTER TABLE trailer_invoices ADD COLUMN IF NOT EXISTS grace_period_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trailer_invoices ADD COLUMN IF NOT EXISTS calculation_inputs JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS trailer_invoice_adjustments (
  id BIGSERIAL PRIMARY KEY,
  invoice_id BIGINT NOT NULL REFERENCES trailer_invoices(id) ON DELETE RESTRICT,
  adjustment_type TEXT NOT NULL,
  amount NUMERIC(14,2) NOT NULL,
  reason TEXT NOT NULL,
  created_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS trailer_payments (
  id BIGSERIAL PRIMARY KEY,
  receipt_number TEXT UNIQUE NOT NULL,
  invoice_id BIGINT NOT NULL REFERENCES trailer_invoices(id) ON DELETE RESTRICT,
  rental_id BIGINT NOT NULL REFERENCES trailer_rentals(id) ON DELETE RESTRICT,
  trailer_id INTEGER NOT NULL REFERENCES trailers(id) ON DELETE RESTRICT,
  company_id BIGINT NOT NULL REFERENCES trailer_renter_companies(id) ON DELETE RESTRICT,
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  payment_at TIMESTAMPTZ NOT NULL,
  payment_method TEXT NOT NULL,
  reference_number TEXT NULL,
  notes TEXT NULL,
  receipt_media_id BIGINT NULL REFERENCES trailer_media(id) ON DELETE RESTRICT,
  receipt_bypass_reason TEXT NULL,
  idempotency_key TEXT NOT NULL,
  verification_status TEXT NOT NULL DEFAULT 'recorded' CHECK (verification_status IN ('recorded','verified','rejected','reversed')),
  recorded_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  verified_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (invoice_id, idempotency_key),
  CHECK (receipt_media_id IS NOT NULL OR receipt_bypass_reason IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_trailer_payments_invoice ON trailer_payments(invoice_id, verification_status);

CREATE TABLE IF NOT EXISTS trailer_payment_reversals (
  id BIGSERIAL PRIMARY KEY,
  payment_id BIGINT UNIQUE NOT NULL REFERENCES trailer_payments(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL,
  reversed_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  reversed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS trailer_notification_jobs (
  id BIGSERIAL PRIMARY KEY,
  job_type TEXT NOT NULL CHECK (job_type IN ('payment_confirmation','overdue_reminder','manual_test')),
  entity_type TEXT NOT NULL,
  entity_id BIGINT NOT NULL,
  idempotency_key TEXT UNIQUE NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','sent','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ NULL,
  last_error TEXT NULL,
  telegram_chat_id TEXT NULL,
  telegram_message_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trailer_notification_ready ON trailer_notification_jobs(status, available_at);

CREATE TABLE IF NOT EXISTS trailer_reminder_history (
  id BIGSERIAL PRIMARY KEY,
  invoice_id BIGINT NOT NULL REFERENCES trailer_invoices(id) ON DELETE RESTRICT,
  notification_job_id BIGINT NULL REFERENCES trailer_notification_jobs(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  note TEXT NULL,
  action_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  action_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NULL
);
CREATE INDEX IF NOT EXISTS idx_trailer_reminder_history_invoice ON trailer_reminder_history(invoice_id, action_at DESC);

CREATE TABLE IF NOT EXISTS trailer_audit_log (
  id BIGSERIAL PRIMARY KEY,
  admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  role_keys TEXT[] NOT NULL DEFAULT '{}',
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  old_values JSONB NULL,
  new_values JSONB NULL,
  reason TEXT NULL,
  ip_address TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trailer_audit_entity ON trailer_audit_log(entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trailer_audit_admin ON trailer_audit_log(admin_id, created_at DESC);

-- Resolve deferred media references now that invoice/payment tables exist.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trailer_media_invoice_fk') THEN
    ALTER TABLE trailer_media ADD CONSTRAINT trailer_media_invoice_fk FOREIGN KEY (invoice_id) REFERENCES trailer_invoices(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trailer_media_payment_fk') THEN
    ALTER TABLE trailer_media ADD CONSTRAINT trailer_media_payment_fk FOREIGN KEY (payment_id) REFERENCES trailer_payments(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trailer_rentals_agreement_media_fk') THEN
    ALTER TABLE trailer_rentals ADD CONSTRAINT trailer_rentals_agreement_media_fk FOREIGN KEY (agreement_media_id) REFERENCES trailer_media(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Rental-generated events link back through the movement table; old events stay
-- untouched and continue to satisfy their original event-source contracts.
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS rental_movement_id BIGINT NULL REFERENCES trailer_rental_movements(id) ON DELETE SET NULL;

-- Extend the existing single-row Trailer settings record.
ALTER TABLE trailer_settings ADD COLUMN IF NOT EXISTS payment_confirmation_group_id TEXT NULL;
ALTER TABLE trailer_settings ADD COLUMN IF NOT EXISTS overdue_reminder_group_id TEXT NULL;
ALTER TABLE trailer_settings ADD COLUMN IF NOT EXISTS responsible_telegram_username TEXT NULL;
ALTER TABLE trailer_settings ADD COLUMN IF NOT EXISTS responsible_telegram_user_id TEXT NULL;
ALTER TABLE trailer_settings ADD COLUMN IF NOT EXISTS escalation_telegram_username TEXT NULL;
ALTER TABLE trailer_settings ADD COLUMN IF NOT EXISTS escalation_telegram_user_id TEXT NULL;
ALTER TABLE trailer_settings ADD COLUMN IF NOT EXISTS reminder_timezone TEXT NOT NULL DEFAULT 'America/Chicago';
ALTER TABLE trailer_settings ADD COLUMN IF NOT EXISTS payment_grace_period_days INTEGER NOT NULL DEFAULT 3;
ALTER TABLE trailer_settings ADD COLUMN IF NOT EXISTS reminder_hour INTEGER NOT NULL DEFAULT 9;
ALTER TABLE trailer_settings ADD COLUMN IF NOT EXISTS reminder_repeat_days INTEGER NOT NULL DEFAULT 1;
ALTER TABLE trailer_settings ADD COLUMN IF NOT EXISTS reminder_escalation_days INTEGER NOT NULL DEFAULT 7;
ALTER TABLE trailer_settings ADD COLUMN IF NOT EXISTS reminder_weekend_behavior TEXT NOT NULL DEFAULT 'skip';
ALTER TABLE trailer_settings ADD COLUMN IF NOT EXISTS reminders_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE trailer_settings ADD COLUMN IF NOT EXISTS payment_group_tested_at TIMESTAMPTZ NULL;
ALTER TABLE trailer_settings ADD COLUMN IF NOT EXISTS overdue_group_tested_at TIMESTAMPTZ NULL;
