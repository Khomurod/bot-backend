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
const { normalizeUnitNumber } = require('../../lib/trailers/normalize');

/** A trailer is official only when it is both active and master-list active. */
const OFFICIAL_PREDICATE = "t.active AND t.master_status = 'active'";

/** Depth cap for merge chains: A -> B -> C. Guards against a cycle looping forever. */
const MAX_MERGE_DEPTH = 10;

/**
 * Follow merged_into_trailer_id to the surviving trailer.
 *
 * A merged trailer KEEPS its old unit number (that is the historical record),
 * so an exact match can land on a shell that is no longer an asset. Resolution
 * has to walk to the survivor, or every Telegram message using the old number
 * would resolve to a non-official record and be queued for review forever
 * instead of attaching to the trailer that actually exists.
 *
 * Chains are possible (A merged into B, later B into C), hence the loop.
 *
 * @returns {Promise<{trailer: object, followed: boolean}>}
 */
async function followMerges(start, run) {
  let trailer = start;
  let followed = false;
  for (let depth = 0; depth < MAX_MERGE_DEPTH; depth += 1) {
    if (trailer.master_status !== 'merged' || !trailer.merged_into_trailer_id) break;
    const next = await run(
      `SELECT t.*, (${OFFICIAL_PREDICATE}) AS is_official FROM trailers t WHERE t.id = $1`,
      [trailer.merged_into_trailer_id],
    );
    if (!next.rows[0]) break; // dangling pointer: keep the shell rather than lose the match
    trailer = next.rows[0];
    followed = true;
  }
  return { trailer, followed };
}

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
    const resolved = await followMerges(direct.rows[0], run);
    return {
      trailer: resolved.trailer,
      // A merged shell keeps its old unit number, so an exact match on it is
      // really an alias match on the survivor.
      matchedBy: resolved.followed ? 'alias' : 'unit_number',
      official: Boolean(resolved.trailer.is_official),
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
    // An alias can point at a trailer that was itself later merged away.
    const resolved = await followMerges(viaAlias.rows[0], run);
    return {
      trailer: resolved.trailer,
      matchedBy: 'alias',
      official: Boolean(resolved.trailer.is_official),
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
