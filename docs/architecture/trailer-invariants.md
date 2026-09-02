# Trailer domain — invariants

Read this before changing the trailer master list, trailer file storage, rental
agreements, or the Trailer Department safety rules. Operational detail (URLs,
feature flag, storage configuration) lives in
[`../trailer-department.md`](../trailer-department.md).

---

## 1. Master list — no code path may create a trailer from a detection

`database/trailerMasterList/`, `services/trailerMasterList/`. The `trailers`
table is the single authoritative master list. **This is a permanent invariant.**

- A trailer may join the list **only** through an approved master-list import or
  explicit, permission-gated manual creation. A Telegram message or an AI
  detection must **never** create one.
- `ensureTrailerForDetection` **resolves only** — exact unit number, then active
  alias, following `merged_into_trailer_id` to the survivor — and returns `null`
  for an unknown unit. Callers must then queue a `trailer_unmatched_mentions`
  review record; they must never insert a trailer.
- Enforcement lives in the **data-access layer**, not only in routes:
  `upsertTrailerByUnitNumber` throws `TRAILER_NOT_IN_MASTER_LIST` for any source
  other than `admin_manual`. Approved-import trailers are created **only** inside
  the reconciliation transaction (`reconciliation.js` `createApproved`, a direct
  INSERT).
- The legacy screenshot importer (`trailerImportService.js` `commitRows` and
  `POST /api/trailers/import/:batchId/commit`) is **disabled on purpose** — it
  produced official trailers with no reconciliation. Do not re-enable a second
  import authority; route image imports through the master-list flow. Guarded by
  `tests/trailerLegacyImportGuard.test.js`.
- **"Official" means `active AND master_status = 'active'`.** `active` keeps its
  legacy soft-delete meaning and is deliberately **not** mirrored from
  `master_status`; both must hold. Pending-review, archived and merged trailers
  keep all their history but must never appear on a map, in a default list, or in
  a rental picker.
- **Archive and merge never delete.** A merge reassigns every history table to
  the survivor and keeps both identifiers resolving as aliases. A trailer with an
  open rental can be neither archived nor merged.
- Master-list imports **stage only**. Reconciliation applies approved decisions
  in one transaction; a failure rolls back every master-list change and leaves
  the staged import intact.

**Tests to run and preserve:** `tests/trailerAutoCreationGuard.test.js` — its
static scan fails if a new `INSERT INTO trailers` site appears, so update
`KNOWN_CREATION_SITES` only deliberately — plus
`tests/trailerMasterListPg.test.js` and `tests/trailerMasterListReconcile.test.js`.

---

## 2. File storage — uploads must work with no Supabase configured

`services/trailerStorage/`, reached through the re-export-only façade
`services/trailerStorageService.js`.

- **Requiring Supabase was a production outage**: every upload threw 503, so the
  required pickup photo never stored, so "Confirm Pickup and Activate" failed.
  Never reintroduce a hard Supabase dependency on the upload path.
- Backend selection is automatic: Supabase when fully configured, otherwise
  `database` (bytes in `trailer_media_blobs`). **Reads follow the
  `storage_backend` recorded on the row**, never the current configuration, so
  files written before Supabase is configured keep working after it is.
- Bytes live in `trailer_media_blobs`, separate from `trailer_media` metadata:
  never select BYTEA in a list query.
- Telegram fetches media through short-lived HMAC-signed URLs
  (`/api/trailer-media/:id`) — the same invariant as Route Control screenshots.
  Never a permanent or unsigned public URL; never log a signed URL or query
  string. The variant (original/preview) is part of the signature.
- Inspections complete **only** through `completeInspection()`, which verifies
  the required photo's metadata **and** bytes inside a transaction.
  `saveInspection()` always writes a draft and ignores `completed`, so a failed
  upload can never leave a completed inspection.

**Tests to run and preserve:** `tests/trailerStoragePg.test.js`,
`tests/trailerStorageFallback.test.js`, `tests/trailerMediaRoutes.test.js`,
`tests/trailerInspectionAtomicityPg.test.js`.

---

## 3. Multi-trailer rental agreements

`database/trailerAgreements/`, `services/trailerAgreements/`,
`services/trailerPricing/`, reached through
`server/routes/trailerAgreementRoutes.js` at `/api/trailer-agreements`. One
company can rent many trailers under one agreement, each trailer an independent
`trailer_rental_items` row with its own pickup/return/pricing.

- `trailer_rental_agreements` is the header; `trailer_rental_items` is one row
  per trailer. Agreement status is **derived** from item statuses by the pure
  `lib/trailers/statusDerivation.js` — never set directly — and
  re-derived inside the **same transaction** as every item change.
- History is **amendment-based**: add/remove/replace/rate/amount/extend changes
  append an immutable `trailer_rental_amendments` row. There is no amendment
  UPDATE path.
- Availability is enforced by the **database**: an EXCLUDE-gist overlap
  constraint (`trailer_rental_items_no_overlap`) plus a partial unique "one
  active item per trailer". Only official trailers may be added (§1).
- Invoicing writes `trailer_invoice_lines` (immutable once finalized;
  corrections go through adjustments/credits) **and** maintains the legacy
  `trailer_invoices` column totals as a denormalized sum, so every existing
  reader keeps working. Combined = one invoice for all items; separate = one per
  item.
- The **legacy backfill is production-critical and idempotent**: `schema.sql`
  creates one agreement + one item per existing `trailer_rentals` row, guarded by
  `legacy_rental_id` (INSERT-only, fill-NULLs-only), and connects existing
  invoices/inspections/movements/media. Re-running on every boot is a strict
  no-op. The old `trailer_rentals` table and `/rentals/*` endpoints stay fully
  functional — nothing is dropped.

**Tests to run and preserve:** `tests/trailerAgreementsPg.test.js`,
`tests/trailerAgreementStatus.test.js`, `tests/trailerPricing.test.js`.

---

## 4. Trailer Department safety invariants

- **User scoping** (`server/routes/adminUserScope.js`): a Trailer Manager
  (`trailer_users.manage` **without** `users.manage`) sees and edits only
  accounts whose roles are all `trailer_`-prefixed. Out-of-scope accounts return
  **404, never 403**, so their existence cannot be inferred. The last active
  super administrator cannot be deactivated or demoted.
- **Overpayments** (`database/trailerFinance.js`, `database/trailerCredits.js`):
  a payment above the outstanding balance is **rejected** unless the caller holds
  `trailer_payments.record_overpayment` **and** confirms; the excess is then
  banked as a `trailer_company_credits` row and applied later through an audited
  ledger. Never silently swallow an overpayment.
- **Snoozed reminders** (`database/trailerNotifications.js`):
  `resumeExpiredSnoozes` restores `reminder_state='snoozed'` invoices whose
  `snoozed_until <= NOW()` to active **before** reminders are enqueued, so an
  expired snooze always resumes.
- **Grace period**: `due_at` is the payment deadline **only**; grace is applied
  exactly once, at reminder time. Never bake grace into `due_at`.
- **Optimistic locking**: trailers, agreements, items, companies and invoices
  carry a `version` column. A write bumps it; a caller that sends a stale version
  gets HTTP 409, never a silent overwrite.
- **AI event linking** (`linkTrailerEventToRental`): links to a **specific
  validated movement**, never "the newest one"; refuses to relink an
  already-linked event or to steal a movement already linked elsewhere.
- **Audit redaction** (`database/trailerAudit.js` `redact`): recursively strips
  passwords, hashes, tokens, secrets and signed-URL material at any depth.

**Tests to run and preserve:** `tests/adminUserScope.test.js`,
`tests/trailerOverpaymentPg.test.js`, `tests/trailerReminderResumePg.test.js`,
`tests/trailerEventLinkPg.test.js`, `tests/trailerAuditRedact.test.js`.
