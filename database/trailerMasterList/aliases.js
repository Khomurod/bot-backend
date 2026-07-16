/**
 * Trailer aliases + the authoritative unit-number resolver — data access.
 *
 * THE central rule of master-list authority lives here: resolution IDENTIFIES
 * an existing trailer and NEVER creates one. Every detection path (Telegram, AI,
 * manual events) funnels through resolveTrailerByUnitOrAlias, so there is one
 * place to audit that a detected number cannot become a trailer.
 *
 * Aliases exist so corrected OCR values, renumbered trailers, merged duplicates
 * and historical numbers keep resolving to the surviving canonical record —
 * which is what lets a merge preserve history instead of destroying it.
 *
 * Depends only on ./pool and the pure normalizer, so it stays acyclic and can
 * be required from database/trailers.js.
 */
'use strict';

const { query } = require('../pool');
const { normalizeUnitNumber } = require('../../services/trailerMasterList/normalize');

/** A trailer is official only when it is both active and master-list active. */
const OFFICIAL_PREDICATE = "t.active AND t.master_status = 'active'";

/**
 * Resolve a detected unit number to its canonical trailer.
 *
 * Order: exact unit number, then an ACTIVE alias. Returns the trailer whatever
 * its master_status, plus how it matched and whether it is official — callers
 * need that distinction: an unofficial (pending/archived/merged) match must be
 * preserved as review evidence WITHOUT reactivating the trailer, while an
 * unresolved number becomes an unmatched mention.
 *
 * NEVER writes. There is no code path from here to an INSERT INTO trailers.
 *
 * @param {string} unitNumber raw detected number
 * @param {object} [options]
 * @param {object} [options.client] existing transaction client
 * @returns {Promise<{trailer:object|null, matchedBy:'unit_number'|'alias'|null, official:boolean, normalizedUnit:string|null}>}
 */
async function resolveTrailerByUnitOrAlias(unitNumber, options = {}) {
  const run = options.client ? (t, v) => options.client.query(t, v) : query;
  const unit = normalizeUnitNumber(unitNumber);
  const miss = { trailer: null, matchedBy: null, official: false, normalizedUnit: unit };
  if (!unit) return { ...miss, normalizedUnit: null };

  const direct = await run(
    `SELECT t.*, (${OFFICIAL_PREDICATE}) AS is_official FROM trailers t WHERE t.unit_number = $1`,
    [unit],
  );
  if (direct.rows[0]) {
    return {
      trailer: direct.rows[0],
      matchedBy: 'unit_number',
      official: Boolean(direct.rows[0].is_official),
      normalizedUnit: unit,
    };
  }

  // An alias resolves to the canonical trailer that survived a correction or
  // merge. A merged trailer's alias points at the survivor, so history follows.
  const viaAlias = await run(
    `SELECT t.*, (${OFFICIAL_PREDICATE}) AS is_official
       FROM trailer_aliases a
       JOIN trailers t ON t.id = a.trailer_id
      WHERE a.alias_unit_number = $1 AND a.active
      LIMIT 1`,
    [unit],
  );
  if (viaAlias.rows[0]) {
    return {
      trailer: viaAlias.rows[0],
      matchedBy: 'alias',
      official: Boolean(viaAlias.rows[0].is_official),
      normalizedUnit: unit,
    };
  }

  return miss;
}

/**
 * Create an alias. Rejects when the value would collide with a live identity:
 * an existing trailer's unit number, or another active alias.
 *
 * @param {object} input
 * @param {object} [options]
 * @param {object} [options.client] existing transaction client (merges need this)
 */
async function createTrailerAlias(input, options = {}) {
  const run = options.client ? (t, v) => options.client.query(t, v) : query;
  const alias = normalizeUnitNumber(input.alias_unit_number);
  if (!alias) throw Object.assign(new Error('An alias unit number is required.'), { status: 400 });
  if (!input.trailer_id) throw Object.assign(new Error('An alias must name its canonical trailer.'), { status: 400 });

  // An alias must never shadow a real trailer — resolution would become
  // ambiguous and the alias could hijack a live unit number.
  const collision = await run('SELECT id FROM trailers WHERE unit_number = $1', [alias]);
  if (collision.rows[0]) {
    throw Object.assign(
      new Error(`${alias} is an active trailer unit number and cannot be used as an alias.`),
      { status: 409 },
    );
  }

  const res = await run(
    `INSERT INTO trailer_aliases
       (alias_unit_number, trailer_id, alias_type, reason, source_import_batch_id, created_by_admin_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      alias,
      Number(input.trailer_id),
      input.alias_type || 'historical',
      input.reason || null,
      input.source_import_batch_id || null,
      options.actor?.id || input.created_by_admin_id || null,
    ],
  );
  return res.rows[0];
}

/** Active + historical aliases for a trailer, newest first. */
async function listTrailerAliases(trailerId) {
  const res = await query(
    'SELECT * FROM trailer_aliases WHERE trailer_id = $1 ORDER BY created_at DESC',
    [Number(trailerId)],
  );
  return res.rows;
}

/** Every active alias, for the reconciliation engine's alias matching. */
async function listActiveAliases(options = {}) {
  const run = options.client ? (t, v) => options.client.query(t, v) : query;
  const res = await run('SELECT alias_unit_number, trailer_id FROM trailer_aliases WHERE active');
  return res.rows;
}

/**
 * Retire an alias without deleting it — the historical record of what the alias
 * meant must survive.
 */
async function deactivateTrailerAlias(id, options = {}) {
  const run = options.client ? (t, v) => options.client.query(t, v) : query;
  const res = await run('UPDATE trailer_aliases SET active = FALSE WHERE id = $1 RETURNING *', [Number(id)]);
  return res.rows[0] || null;
}

module.exports = {
  resolveTrailerByUnitOrAlias,
  createTrailerAlias,
  listTrailerAliases,
  listActiveAliases,
  deactivateTrailerAlias,
  OFFICIAL_PREDICATE,
};
