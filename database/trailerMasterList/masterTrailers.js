/**
 * The trailers master list — data access.
 *
 * `trailers` is the single authoritative master list for every part of the
 * application. This module owns reading it and the ONLY general-purpose write
 * path onto it, so the creation rule is enforceable in one reviewable place:
 *
 *   A trailer may be created ONLY by permission-gated manual creation or an
 *   approved master-list import. Never by a Telegram message or AI detection.
 *
 * Extracted from database/trailers.js, which re-exports every function here so
 * existing `require('./db')` / `require('./trailers')` callers keep working.
 * Depends only on ./pool, the sibling alias resolver, and pure helpers.
 */
'use strict';

const { query } = require('../pool');
const { normalizeUnitNumber } = require('../../services/trailerMasterList/normalize');
const { resolveTrailerByUnitOrAlias } = require('./aliases');

/** Master-data fields carried on a trailer record. */
const TRAILER_FIELDS = ['make', 'model', 'mc_number', 'plate_number', 'type', 'vin', 'year', 'ownership_status'];

/** Trim to a bounded string, or null for empty/blank. Never throws. */
function s(value, max = 500) {
  if (value == null) return null;
  const t = String(value).trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max) : t;
}

/**
 * `source` values that may bring a trailer onto the master list through this
 * general-purpose write path, mapped to the master_source they record.
 *
 * ONLY 'admin_manual' is creatable here. 'telegram_detected' is absent — a
 * detection must never create a trailer. 'screenshot_import' is ALSO absent on
 * purpose: the legacy screenshot importer must not be a second, unreviewed
 * trailer-creation authority. Approved-import trailers are created exclusively
 * inside the reconciliation transaction (database/trailerMasterList/
 * reconciliation.js `createApproved`), which requires a confirmed complete
 * snapshot, a reviewer decision, and a permanent reconciliation-log entry.
 * Removing it here closes the bypass where a raw commit could mint official
 * trailers with no reconciliation. See tests/trailerAutoCreationGuard.test.js.
 */
const CREATABLE_SOURCES = new Map([
  ['admin_manual', 'admin_manual'],
]);

async function getTrailerById(id) {
  const res = await query('SELECT * FROM trailers WHERE id = $1', [Number(id)]);
  return res.rows[0] || null;
}

async function getTrailerByUnitNumber(unitNumber) {
  const unit = normalizeUnitNumber(unitNumber);
  if (!unit) return null;
  const res = await query('SELECT * FROM trailers WHERE unit_number = $1', [unit]);
  return res.rows[0] || null;
}

/**
 * Upsert a trailer by unit number. Only NON-EMPTY provided fields are written;
 * existing values are never clobbered with blanks. Returns the row.
 *
 * CREATION IS RESTRICTED. A new row may only originate from permission-gated
 * manual creation or an approved import; any other source throws. Enforced HERE,
 * in the data access layer, so a future caller cannot reintroduce automatic
 * creation by going around a route check. Updating an existing trailer is
 * unrestricted — a legacy detection-created trailer is still real history and
 * must stay editable.
 *
 * On update `needs_review`/`active` are only set when explicitly provided.
 */
async function upsertTrailerByUnitNumber(input = {}) {
  const unit = normalizeUnitNumber(input.unit_number);
  if (!unit) return null;

  const existing = await getTrailerByUnitNumber(unit);
  const source = s(input.source) || (existing ? existing.source : 'admin_manual');

  if (!existing) {
    const masterSource = CREATABLE_SOURCES.get(source);
    if (!masterSource) {
      throw Object.assign(
        new Error('Create or approve the trailer in the master list before registering it.'),
        { status: 422, code: 'TRAILER_NOT_IN_MASTER_LIST' },
      );
    }
    const cols = ['unit_number', 'source', 'master_source', 'master_status'];
    const vals = [unit, source, masterSource, 'active'];
    for (const f of TRAILER_FIELDS) {
      if (input[f] != null && s(input[f]) != null) { cols.push(f); vals.push(s(input[f])); }
    }
    if (input.master_import_batch_id != null) {
      cols.push('master_import_batch_id');
      vals.push(Number(input.master_import_batch_id));
    }
    if (input.master_verified_by_admin_id != null) {
      cols.push('master_verified_by_admin_id', 'master_verified_at');
      vals.push(Number(input.master_verified_by_admin_id), new Date());
    }
    if (input.needs_review != null) { cols.push('needs_review'); vals.push(Boolean(input.needs_review)); }
    if (input.active != null) { cols.push('active'); vals.push(Boolean(input.active)); }
    const placeholders = vals.map((_, i) => `$${i + 1}`);
    const res = await query(
      `INSERT INTO trailers (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
      vals,
    );
    return res.rows[0];
  }

  // Update: only overwrite with non-blank provided values.
  const sets = [];
  const vals = [];
  let i = 1;
  for (const f of TRAILER_FIELDS) {
    if (input[f] != null && s(input[f]) != null) {
      sets.push(`${f} = $${i++}`);
      vals.push(s(input[f]));
    }
  }
  if (input.needs_review != null) { sets.push(`needs_review = $${i++}`); vals.push(Boolean(input.needs_review)); }
  if (input.active != null) { sets.push(`active = $${i++}`); vals.push(Boolean(input.active)); }
  if (!sets.length) return existing;
  sets.push('updated_at = NOW()');
  // Optimistic locking: bump version on every write, and when the caller sends
  // the version it loaded, refuse to overwrite a newer row (HTTP 409).
  sets.push('version = version + 1');
  vals.push(existing.id);
  let where = `id = $${i++}`;
  if (input.version != null) {
    where += ` AND version = $${i++}`;
    vals.push(Number(input.version));
  }
  const res = await query(
    `UPDATE trailers SET ${sets.join(', ')} WHERE ${where} RETURNING *`,
    vals,
  );
  if (!res.rows[0] && input.version != null) {
    throw Object.assign(
      new Error('This trailer was changed by someone else. Reload and try again.'),
      { status: 409, code: 'VERSION_CONFLICT', currentVersion: existing.version },
    );
  }
  return res.rows[0];
}

/**
 * Resolve a detected unit number to its canonical trailer. RESOLVE-ONLY.
 *
 * This used to CREATE a stub trailer (source='telegram_detected') for any unit
 * number a Telegram message mentioned, so OCR noise and typos silently became
 * assets on the master list and the map.
 *
 * Returns null when the number matches no trailer and no active alias. Callers
 * MUST handle null by queueing an unmatched mention for review (see
 * ./mentions.js) — never by creating a trailer.
 *
 * The name is kept so existing call sites stay put; only the unresolved case
 * changed. Guarded by tests/trailerAutoCreationGuard.test.js.
 */
async function ensureTrailerForDetection(unitNumber) {
  const { trailer } = await resolveTrailerByUnitOrAlias(unitNumber);
  return trailer;
}

module.exports = {
  TRAILER_FIELDS,
  CREATABLE_SOURCES,
  getTrailerById,
  getTrailerByUnitNumber,
  upsertTrailerByUnitNumber,
  ensureTrailerForDetection,
};
