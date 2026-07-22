-- ============================================================================
-- TRAILER DEPARTMENT: MULTI-TRAILER RENTAL AGREEMENTS (Phase 4)
--
-- One company renting several trailers used to need several unrelated
-- single-trailer rentals. This adds an agreement header with per-trailer items,
-- so a single agreement can carry many trailers each with its own pickup,
-- return, pricing and lifecycle, plus amendments, invoice lines and company
-- credits.
--
-- EVERYTHING here is additive and idempotent — this file runs on every boot.
-- The legacy `trailer_rentals` table and its endpoints are left fully intact;
-- nothing is dropped. Existing single-trailer rentals are backfilled into
-- agreements+items at the end, guarded by `legacy_rental_id` so the backfill is
-- a strict INSERT-only / fill-NULLs-only no-op on re-run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS trailer_rental_agreements (
  id BIGSERIAL PRIMARY KEY,
  agreement_number TEXT UNIQUE NOT NULL,
  company_id BIGINT NOT NULL REFERENCES trailer_renter_companies(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'draft',
  pricing_mode TEXT NOT NULL DEFAULT 'per_item',
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  agreement_date DATE NULL,
  start_date TIMESTAMPTZ NULL,
  original_agreed_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  current_agreed_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  deposit_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  agreement_discount NUMERIC(14,2) NOT NULL DEFAULT 0,
  payment_terms TEXT NULL,
  payment_due_rule TEXT NULL,
  payment_grace_period_days INTEGER NOT NULL DEFAULT 0,
  billing_timezone TEXT NOT NULL DEFAULT 'America/Chicago',
  notes TEXT NULL,
  agreement_media_id BIGINT NULL REFERENCES trailer_media(id) ON DELETE SET NULL,
  created_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  updated_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  closed_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ NULL,
  version INTEGER NOT NULL DEFAULT 1,
  legacy_rental_id BIGINT NULL UNIQUE REFERENCES trailer_rentals(id) ON DELETE SET NULL
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'trailer_rental_agreements_status_check'
       AND conrelid = 'trailer_rental_agreements'::regclass
  ) THEN
    ALTER TABLE trailer_rental_agreements ADD CONSTRAINT trailer_rental_agreements_status_check CHECK (
      status IN ('draft','scheduled','partially_active','active','partially_returned',
                 'returned','closed','cancelled','disputed')
    );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'trailer_rental_agreements_pricing_check'
       AND conrelid = 'trailer_rental_agreements'::regclass
  ) THEN
    ALTER TABLE trailer_rental_agreements ADD CONSTRAINT trailer_rental_agreements_pricing_check CHECK (
      pricing_mode IN ('per_item','bundle_flat','bundle_daily','bundle_weekly','bundle_monthly','mixed')
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_trailer_agreements_company ON trailer_rental_agreements(company_id, status);
CREATE INDEX IF NOT EXISTS idx_trailer_agreements_status ON trailer_rental_agreements(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trailer_agreements_legacy ON trailer_rental_agreements(legacy_rental_id) WHERE legacy_rental_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS trailer_rental_items (
  id BIGSERIAL PRIMARY KEY,
  agreement_id BIGINT NOT NULL REFERENCES trailer_rental_agreements(id) ON DELETE CASCADE,
  trailer_id INTEGER NOT NULL REFERENCES trailers(id) ON DELETE RESTRICT,
  item_sequence INTEGER NOT NULL DEFAULT 1,
  item_status TEXT NOT NULL DEFAULT 'draft',
  scheduled_pickup_at TIMESTAMPTZ NULL,
  actual_pickup_at TIMESTAMPTZ NULL,
  expected_return_at TIMESTAMPTZ NULL,
  actual_return_at TIMESTAMPTZ NULL,
  pickup_location TEXT NULL,
  pickup_lat DOUBLE PRECISION NULL,
  pickup_lng DOUBLE PRECISION NULL,
  return_location TEXT NULL,
  return_lat DOUBLE PRECISION NULL,
  return_lng DOUBLE PRECISION NULL,
  pricing_mode TEXT NOT NULL DEFAULT 'daily',
  daily_rate NUMERIC(14,2) NULL,
  weekly_rate NUMERIC(14,2) NULL,
  monthly_rate NUMERIC(14,2) NULL,
  flat_amount NUMERIC(14,2) NULL,
  included_in_bundle BOOLEAN NOT NULL DEFAULT FALSE,
  additional_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  discount_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  deposit_allocation NUMERIC(14,2) NOT NULL DEFAULT 0,
  grace_period_override INTEGER NULL,
  billing_timezone_override TEXT NULL,
  notes TEXT NULL,
  added_amendment_id BIGINT NULL,
  removed_amendment_id BIGINT NULL,
  replacement_item_id BIGINT NULL REFERENCES trailer_rental_items(id) ON DELETE SET NULL,
  created_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  updated_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INTEGER NOT NULL DEFAULT 1,
  legacy_rental_id BIGINT NULL UNIQUE REFERENCES trailer_rentals(id) ON DELETE SET NULL
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'trailer_rental_items_status_check'
       AND conrelid = 'trailer_rental_items'::regclass
  ) THEN
    ALTER TABLE trailer_rental_items ADD CONSTRAINT trailer_rental_items_status_check CHECK (
      item_status IN ('draft','scheduled','ready_for_pickup','active','returned',
                      'removed_before_pickup','replaced','cancelled','disputed')
    );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'trailer_rental_items_pricing_check'
       AND conrelid = 'trailer_rental_items'::regclass
  ) THEN
    ALTER TABLE trailer_rental_items ADD CONSTRAINT trailer_rental_items_pricing_check CHECK (
      pricing_mode IN ('daily','weekly','monthly','flat','included_in_bundle','manual')
    );
  END IF;
  -- A schedulable/active item must have a pickup and expected-return window so
  -- the exclusion constraint below has a bounded range to compare. Mirrors the
  -- proven CHECK on trailer_rentals.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'trailer_rental_items_window_check'
       AND conrelid = 'trailer_rental_items'::regclass
  ) THEN
    ALTER TABLE trailer_rental_items ADD CONSTRAINT trailer_rental_items_window_check CHECK (
      item_status NOT IN ('scheduled','ready_for_pickup','active')
      OR (scheduled_pickup_at IS NOT NULL AND expected_return_at IS NOT NULL
          AND expected_return_at > scheduled_pickup_at)
    );
  END IF;
END $$;

-- No two schedulable/active items may claim the same trailer over overlapping
-- windows — the multi-trailer analogue of trailer_rentals_no_scheduled_overlap.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trailer_rental_items_no_overlap') THEN
    ALTER TABLE trailer_rental_items ADD CONSTRAINT trailer_rental_items_no_overlap
      EXCLUDE USING gist (
        trailer_id WITH =,
        tstzrange(scheduled_pickup_at, expected_return_at, '[)') WITH &&
      ) WHERE (item_status IN ('scheduled','ready_for_pickup','active'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_trailer_item_one_active
  ON trailer_rental_items(trailer_id) WHERE item_status = 'active';
CREATE INDEX IF NOT EXISTS idx_trailer_items_agreement ON trailer_rental_items(agreement_id, item_sequence);
CREATE INDEX IF NOT EXISTS idx_trailer_items_trailer ON trailer_rental_items(trailer_id, item_status);
CREATE INDEX IF NOT EXISTS idx_trailer_items_legacy ON trailer_rental_items(legacy_rental_id) WHERE legacy_rental_id IS NOT NULL;

-- Immutable amendment ledger. Append-only by convention; there is no UPDATE path.
CREATE TABLE IF NOT EXISTS trailer_rental_amendments (
  id BIGSERIAL PRIMARY KEY,
  agreement_id BIGINT NOT NULL REFERENCES trailer_rental_agreements(id) ON DELETE CASCADE,
  amendment_number INTEGER NOT NULL,
  amendment_type TEXT NOT NULL,
  effective_date TIMESTAMPTZ NULL,
  previous_amount NUMERIC(14,2) NULL,
  change_amount NUMERIC(14,2) NULL,
  new_amount NUMERIC(14,2) NULL,
  previous_pricing_terms JSONB NULL,
  new_pricing_terms JSONB NULL,
  reason TEXT NULL,
  notes TEXT NULL,
  supporting_media_id BIGINT NULL REFERENCES trailer_media(id) ON DELETE SET NULL,
  rental_item_id BIGINT NULL REFERENCES trailer_rental_items(id) ON DELETE SET NULL,
  created_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agreement_id, amendment_number)
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'trailer_rental_amendments_type_check'
       AND conrelid = 'trailer_rental_amendments'::regclass
  ) THEN
    ALTER TABLE trailer_rental_amendments ADD CONSTRAINT trailer_rental_amendments_type_check CHECK (
      amendment_type IN ('add_trailer','remove_trailer','replace_trailer','increase_amount',
                         'decrease_amount','change_rate','extend_return','change_payment_terms','other')
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_trailer_amendments_agreement ON trailer_rental_amendments(agreement_id, amendment_number);

-- Invoice lines: one row per billed trailer/charge on an agreement invoice.
-- Finalized lines are immutable; corrections go through adjustments/credits.
CREATE TABLE IF NOT EXISTS trailer_invoice_lines (
  id BIGSERIAL PRIMARY KEY,
  invoice_id BIGINT NOT NULL REFERENCES trailer_invoices(id) ON DELETE CASCADE,
  agreement_id BIGINT NULL REFERENCES trailer_rental_agreements(id) ON DELETE SET NULL,
  agreement_item_id BIGINT NULL REFERENCES trailer_rental_items(id) ON DELETE SET NULL,
  trailer_id INTEGER NULL REFERENCES trailers(id) ON DELETE SET NULL,
  line_type TEXT NOT NULL DEFAULT 'rental',
  description TEXT NULL,
  quantity NUMERIC(14,4) NOT NULL DEFAULT 1,
  unit TEXT NULL,
  unit_price NUMERIC(14,2) NOT NULL DEFAULT 0,
  base_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  discount_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  damage_charge NUMERIC(14,2) NOT NULL DEFAULT 0,
  cleaning_charge NUMERIC(14,2) NOT NULL DEFAULT 0,
  late_fee NUMERIC(14,2) NOT NULL DEFAULT 0,
  other_charge NUMERIC(14,2) NOT NULL DEFAULT 0,
  line_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  calculation_inputs JSONB NOT NULL DEFAULT '{}'::jsonb,
  service_period_start TIMESTAMPTZ NULL,
  service_period_end TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'trailer_invoice_lines_type_check'
       AND conrelid = 'trailer_invoice_lines'::regclass
  ) THEN
    ALTER TABLE trailer_invoice_lines ADD CONSTRAINT trailer_invoice_lines_type_check CHECK (
      line_type IN ('rental','bundle','deposit','damage','cleaning','late_fee','discount','adjustment','other')
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_trailer_invoice_lines_invoice ON trailer_invoice_lines(invoice_id);
CREATE INDEX IF NOT EXISTS idx_trailer_invoice_lines_item ON trailer_invoice_lines(agreement_item_id) WHERE agreement_item_id IS NOT NULL;

-- Company credits (overpayments, goodwill) and the ledger that applies them.
CREATE TABLE IF NOT EXISTS trailer_company_credits (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES trailer_renter_companies(id) ON DELETE RESTRICT,
  source_payment_id BIGINT NULL REFERENCES trailer_payments(id) ON DELETE SET NULL,
  source_invoice_id BIGINT NULL REFERENCES trailer_invoices(id) ON DELETE SET NULL,
  original_amount NUMERIC(14,2) NOT NULL CHECK (original_amount > 0),
  remaining_amount NUMERIC(14,2) NOT NULL CHECK (remaining_amount >= 0),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  reason TEXT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_at TIMESTAMPTZ NULL
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'trailer_company_credits_status_check'
       AND conrelid = 'trailer_company_credits'::regclass
  ) THEN
    ALTER TABLE trailer_company_credits ADD CONSTRAINT trailer_company_credits_status_check CHECK (
      status IN ('active','partially_applied','applied','void')
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_trailer_company_credits_company ON trailer_company_credits(company_id, status);

CREATE TABLE IF NOT EXISTS trailer_company_credit_applications (
  id BIGSERIAL PRIMARY KEY,
  credit_id BIGINT NOT NULL REFERENCES trailer_company_credits(id) ON DELETE RESTRICT,
  invoice_id BIGINT NULL REFERENCES trailer_invoices(id) ON DELETE SET NULL,
  payment_id BIGINT NULL REFERENCES trailer_payments(id) ON DELETE SET NULL,
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  applied_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trailer_credit_apps_credit ON trailer_company_credit_applications(credit_id);
CREATE INDEX IF NOT EXISTS idx_trailer_credit_apps_invoice ON trailer_company_credit_applications(invoice_id) WHERE invoice_id IS NOT NULL;

-- Nullable agreement/item references on existing tables (additive = safe).
ALTER TABLE trailer_invoices ADD COLUMN IF NOT EXISTS agreement_id BIGINT NULL REFERENCES trailer_rental_agreements(id) ON DELETE SET NULL;
ALTER TABLE trailer_invoices ADD COLUMN IF NOT EXISTS rental_item_id BIGINT NULL REFERENCES trailer_rental_items(id) ON DELETE SET NULL;
ALTER TABLE trailer_invoices ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE trailer_inspections ADD COLUMN IF NOT EXISTS agreement_id BIGINT NULL REFERENCES trailer_rental_agreements(id) ON DELETE SET NULL;
ALTER TABLE trailer_inspections ADD COLUMN IF NOT EXISTS rental_item_id BIGINT NULL REFERENCES trailer_rental_items(id) ON DELETE SET NULL;
ALTER TABLE trailer_rental_movements ADD COLUMN IF NOT EXISTS agreement_id BIGINT NULL REFERENCES trailer_rental_agreements(id) ON DELETE SET NULL;
ALTER TABLE trailer_rental_movements ADD COLUMN IF NOT EXISTS rental_item_id BIGINT NULL REFERENCES trailer_rental_items(id) ON DELETE SET NULL;
ALTER TABLE trailer_media ADD COLUMN IF NOT EXISTS agreement_id BIGINT NULL REFERENCES trailer_rental_agreements(id) ON DELETE SET NULL;
ALTER TABLE trailer_media ADD COLUMN IF NOT EXISTS rental_item_id BIGINT NULL REFERENCES trailer_rental_items(id) ON DELETE SET NULL;
ALTER TABLE trailer_renter_companies ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_trailer_invoices_agreement ON trailer_invoices(agreement_id) WHERE agreement_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trailer_invoices_item ON trailer_invoices(rental_item_id) WHERE rental_item_id IS NOT NULL;

-- New permissions. super_admin gets them via its CROSS JOIN grant and
-- trailer_manager via its LIKE 'trailer%' grant, both re-run below.
INSERT INTO permissions (permission_key, description) VALUES
  ('trailer_agreements.view', 'View multi-trailer rental agreements'),
  ('trailer_agreements.manage', 'Create and manage multi-trailer rental agreements'),
  ('trailer_payments.record_overpayment', 'Record a payment above the outstanding balance and bank the excess as company credit')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.system_key = 'super_admin'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.system_key = 'trailer_manager'
  AND (p.permission_key LIKE 'trailer%' OR p.permission_key LIKE 'trailers.%')
ON CONFLICT DO NOTHING;

-- ----------------------------------------------------------------------------
-- Backfill: existing single-trailer rentals become one agreement + one item.
-- INSERT-only and fill-NULLs-only, guarded by legacy_rental_id / IS NULL, so a
-- re-run on every boot creates no duplicates and overwrites nothing.
-- ----------------------------------------------------------------------------
INSERT INTO trailer_rental_agreements (
  agreement_number, company_id, status, pricing_mode, currency, agreement_date,
  start_date, original_agreed_amount, current_agreed_amount, deposit_amount,
  agreement_discount, payment_terms, payment_grace_period_days, notes,
  agreement_media_id, created_by_admin_id, updated_by_admin_id, closed_by_admin_id,
  created_at, updated_at, closed_at, legacy_rental_id
)
SELECT
  r.agreement_number, r.company_id, r.status, 'per_item', r.currency,
  r.created_at::date, r.start_at,
  COALESCE(r.flat_rate, 0), COALESCE(r.flat_rate, 0), r.deposit_amount,
  r.discount_amount, r.payment_terms, r.grace_period_days, r.notes,
  r.agreement_media_id, r.created_by_admin_id, r.updated_by_admin_id, r.closed_by_admin_id,
  r.created_at, r.updated_at, r.closed_at, r.id
FROM trailer_rentals r
WHERE NOT EXISTS (
  SELECT 1 FROM trailer_rental_agreements a WHERE a.legacy_rental_id = r.id
);

INSERT INTO trailer_rental_items (
  agreement_id, trailer_id, item_sequence, item_status,
  scheduled_pickup_at, actual_pickup_at, expected_return_at, actual_return_at,
  pickup_location, pickup_lat, pickup_lng, return_location, return_lat, return_lng,
  pricing_mode, daily_rate, flat_amount, deposit_allocation, discount_amount,
  notes, created_by_admin_id, created_at, updated_at, legacy_rental_id
)
SELECT
  a.id, r.trailer_id, 1,
  CASE WHEN r.status = 'closed' THEN 'returned' ELSE r.status END,
  r.start_at,
  CASE WHEN r.status IN ('active','returned','closed') THEN r.start_at ELSE NULL END,
  r.expected_return_at, r.actual_return_at,
  r.pickup_location, r.pickup_lat, r.pickup_lng,
  r.return_location, r.return_lat, r.return_lng,
  CASE r.billing_method WHEN 'flat_rate' THEN 'flat' WHEN 'manual_days' THEN 'manual' ELSE 'daily' END,
  r.daily_rate, r.flat_rate, r.deposit_amount, r.discount_amount,
  r.notes, r.created_by_admin_id, r.created_at, r.updated_at, r.id
FROM trailer_rentals r
JOIN trailer_rental_agreements a ON a.legacy_rental_id = r.id
WHERE NOT EXISTS (
  SELECT 1 FROM trailer_rental_items it WHERE it.legacy_rental_id = r.id
);

-- Connect existing invoices / inspections / movements / media to the backfilled
-- agreement + item. Fill-NULLs-only; a re-run touches nothing already linked.
UPDATE trailer_invoices inv
   SET agreement_id = a.id, rental_item_id = it.id
  FROM trailer_rental_agreements a
  JOIN trailer_rental_items it ON it.agreement_id = a.id
 WHERE a.legacy_rental_id = inv.rental_id
   AND inv.agreement_id IS NULL;

UPDATE trailer_inspections ins
   SET agreement_id = a.id, rental_item_id = it.id
  FROM trailer_rental_agreements a
  JOIN trailer_rental_items it ON it.agreement_id = a.id
 WHERE a.legacy_rental_id = ins.rental_id
   AND ins.agreement_id IS NULL;

UPDATE trailer_rental_movements mv
   SET agreement_id = a.id, rental_item_id = it.id
  FROM trailer_rental_agreements a
  JOIN trailer_rental_items it ON it.agreement_id = a.id
 WHERE a.legacy_rental_id = mv.rental_id
   AND mv.rental_id IS NOT NULL
   AND mv.agreement_id IS NULL;

UPDATE trailer_media m
   SET agreement_id = a.id, rental_item_id = it.id
  FROM trailer_rental_agreements a
  JOIN trailer_rental_items it ON it.agreement_id = a.id
 WHERE a.legacy_rental_id = m.rental_id
   AND m.rental_id IS NOT NULL
   AND m.agreement_id IS NULL;

-- Item-scoped inspections & movements for the agreement model. Additive: legacy
-- rows keep their NOT NULL rental_id; new agreement items reference an inspection
-- by rental_item_id instead. Exactly one of the two keys must be present.
ALTER TABLE trailer_inspections ALTER COLUMN rental_id DROP NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'trailer_inspections_scope_check' AND conrelid = 'trailer_inspections'::regclass
  ) THEN
    ALTER TABLE trailer_inspections ADD CONSTRAINT trailer_inspections_scope_check CHECK (
      rental_id IS NOT NULL OR rental_item_id IS NOT NULL
    );
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_trailer_inspection_item_type
  ON trailer_inspections(rental_item_id, inspection_type) WHERE rental_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trailer_inspections_item ON trailer_inspections(rental_item_id) WHERE rental_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trailer_movements_item ON trailer_rental_movements(rental_item_id) WHERE rental_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trailer_media_item ON trailer_media(rental_item_id) WHERE rental_item_id IS NOT NULL;

-- Agreement invoices may not map to a single legacy rental/trailer (a combined
-- invoice covers several trailers; a brand-new agreement has no legacy rental).
-- Make the legacy single-trailer keys nullable and require an agreement instead.
-- Additive: existing legacy invoices keep both keys populated.
ALTER TABLE trailer_invoices ALTER COLUMN rental_id DROP NOT NULL;
ALTER TABLE trailer_invoices ALTER COLUMN trailer_id DROP NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'trailer_invoices_scope_check' AND conrelid = 'trailer_invoices'::regclass
  ) THEN
    ALTER TABLE trailer_invoices ADD CONSTRAINT trailer_invoices_scope_check CHECK (
      rental_id IS NOT NULL OR agreement_id IS NOT NULL
    );
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- Phase A stabilization: agreement-native payments, persisted return charges,
-- and optimistic locking for trailers. Additive + idempotent (runs every boot).
-- ----------------------------------------------------------------------------

-- Agreement-only invoices (no legacy rental / single trailer) must be payable.
-- invoice_id stays NOT NULL — it is the real anchor of every payment.
ALTER TABLE trailer_payments ALTER COLUMN rental_id DROP NOT NULL;
ALTER TABLE trailer_payments ALTER COLUMN trailer_id DROP NOT NULL;
ALTER TABLE trailer_payments ADD COLUMN IF NOT EXISTS agreement_id BIGINT NULL REFERENCES trailer_rental_agreements(id) ON DELETE SET NULL;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'trailer_payments_scope_check' AND conrelid = 'trailer_payments'::regclass
  ) THEN
    ALTER TABLE trailer_payments ADD CONSTRAINT trailer_payments_scope_check CHECK (
      rental_id IS NOT NULL OR invoice_id IS NOT NULL
    );
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_trailer_payments_agreement ON trailer_payments(agreement_id) WHERE agreement_id IS NOT NULL;

-- Charges entered at item return must survive until invoicing.
ALTER TABLE trailer_rental_items ADD COLUMN IF NOT EXISTS return_charges JSONB NULL;

-- Optimistic locking for trailers (agreements/items/invoices/companies already
-- carry a version column).
ALTER TABLE trailers ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

-- Actual pickup details captured at "Confirm pickup" time. The planned pickup
-- (pickup_location / pickup_lat / pickup_lng, plus scheduled_pickup_at) is kept
-- intact; these hold what the employee actually recorded on the ground so the
-- scheduled and the real pickup are never conflated. Additive + idempotent.
ALTER TABLE trailer_rental_items ADD COLUMN IF NOT EXISTS actual_pickup_location TEXT NULL;
ALTER TABLE trailer_rental_items ADD COLUMN IF NOT EXISTS actual_pickup_lat DOUBLE PRECISION NULL;
ALTER TABLE trailer_rental_items ADD COLUMN IF NOT EXISTS actual_pickup_lng DOUBLE PRECISION NULL;

-- Optimistic locking for roles: a custom-role edit that sends a stale version
-- gets a 409 instead of silently clobbering a concurrent change. Additive.
ALTER TABLE roles ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
