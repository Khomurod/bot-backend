/**
 * Master-list reconciliation decision engine — PURE functions only.
 *
 * Compares a staged COMPLETE snapshot (extracted from the uploaded photos)
 * against the existing trailer database and sorts every row into the four
 * groups the reviewer acts on:
 *
 *   matched      in both     -> keep the database ID and all history; only
 *                              apply reviewed field diffs
 *   new          upload only -> create after explicit approval
 *   missing      database only -> pending_master_review; NEVER auto-archived
 *   conflicting  ambiguous  -> must be resolved by a human before commit
 *
 * This module DECIDES only. It never writes, so the rules stay directly
 * unit-testable; services/trailerMasterList/apply.js performs the approved
 * decisions transactionally.
 */
'use strict';

const { normalizeUnitNumber, confusableSkeleton, suggestSimilar } = require('../../lib/trailers/normalize');

/** Fields carried from an extracted row onto a trailer master record. */
const MASTER_FIELDS = ['make', 'model', 'mc_number', 'plate_number', 'type', 'vin', 'year', 'ownership_status'];

/** Changing one of these changes WHICH physical asset the record is — confirm explicitly. */
const IDENTITY_CRITICAL_FIELDS = ['unit_number', 'vin'];

const blank = (value) => value == null || String(value).trim() === '';
const clean = (value) => (blank(value) ? null : String(value).trim());

/**
 * Collapse rows that repeat across overlapping photos into one row per unit.
 *
 * Overlapping screenshots are expected, so a repeat is NOT a conflict by
 * itself: identical (or blank-vs-filled) repeats merge silently, and only rows
 * that genuinely disagree on a value are flagged for review.
 *
 * @param {Array<object>} rows extracted rows
 * @returns {{rows: Array<object>, duplicateGroups: Array<object>}}
 */
function deduplicateRows(rows = []) {
  const byUnit = new Map();
  const duplicateGroups = [];

  for (const row of rows) {
    const unit = normalizeUnitNumber(row.unit_number);
    if (!unit) continue;
    const existing = byUnit.get(unit);
    if (!existing) {
      byUnit.set(unit, {
        ...row,
        unit_number: unit,
        source_rows: [row],
        field_conflicts: {},
      });
      continue;
    }

    existing.source_rows.push(row);
    for (const field of MASTER_FIELDS) {
      const incoming = clean(row[field]);
      const current = clean(existing[field]);
      if (incoming == null) continue;
      if (current == null) {
        existing[field] = incoming; // fill a gap from another photo
      } else if (current.toUpperCase() !== incoming.toUpperCase()) {
        // Real disagreement between two photos of the same trailer.
        existing.field_conflicts[field] = Array.from(new Set([
          ...(existing.field_conflicts[field] || [current]),
          incoming,
        ]));
      }
    }
  }

  for (const row of byUnit.values()) {
    if (row.source_rows.length > 1) {
      duplicateGroups.push({
        unit_number: row.unit_number,
        occurrences: row.source_rows.length,
        images: Array.from(new Set(row.source_rows.map((r) => r.source_image_index).filter((i) => i != null))),
        conflicts: row.field_conflicts,
      });
    }
  }

  return { rows: Array.from(byUnit.values()), duplicateGroups };
}

/**
 * Cross-row identity conflicts within the snapshot itself:
 *   - one VIN claimed by several unit numbers
 *   - unit numbers that differ only by confusable characters (0/O, 1/I, …)
 * A unit number appearing with two different VINs is already caught as a
 * field_conflict by deduplicateRows.
 */
function detectSnapshotConflicts(rows = []) {
  const conflicts = [];
  const byVin = new Map();

  for (const row of rows) {
    const vin = clean(row.vin);
    if (!vin) continue;
    const key = vin.toUpperCase();
    if (!byVin.has(key)) byVin.set(key, []);
    byVin.get(key).push(row.unit_number);
  }
  for (const [vin, units] of byVin) {
    const distinct = Array.from(new Set(units));
    if (distinct.length > 1) {
      conflicts.push({ type: 'vin_shared_by_multiple_units', vin, unit_numbers: distinct });
    }
  }

  const bySkeleton = new Map();
  for (const row of rows) {
    const skeleton = confusableSkeleton(row.unit_number);
    if (!skeleton) continue;
    if (!bySkeleton.has(skeleton)) bySkeleton.set(skeleton, []);
    bySkeleton.get(skeleton).push(row.unit_number);
  }
  for (const [, units] of bySkeleton) {
    const distinct = Array.from(new Set(units));
    if (distinct.length > 1) {
      conflicts.push({ type: 'confusable_unit_numbers', unit_numbers: distinct });
    }
  }

  return conflicts;
}

/**
 * Field-by-field diff for a matched trailer.
 *
 * A BLANK extracted value NEVER overwrites an existing non-blank value — the AI
 * failing to read a column is not evidence the data is gone. Only genuine
 * changes are proposed, and identity-critical ones are marked for explicit
 * confirmation.
 */
function diffMatched(trailer, row) {
  const changes = [];
  for (const field of MASTER_FIELDS) {
    const incoming = clean(row[field]);
    const current = clean(trailer[field]);
    if (incoming == null) continue; // blank never overwrites
    if (current != null && current.toUpperCase() === incoming.toUpperCase()) continue;
    changes.push({
      field,
      from: current,
      to: incoming,
      identity_critical: IDENTITY_CRITICAL_FIELDS.includes(field),
      confidence: row.field_confidence?.[field] ?? null,
    });
  }
  return changes;
}

/**
 * Reconcile a staged complete snapshot against the current master list.
 *
 * @param {object} input
 * @param {Array<object>} input.snapshotRows deduplicated extracted rows
 * @param {Array<object>} input.trailers every non-archived trailer in the database
 * @param {Array<object>} [input.aliases] active aliases: {alias_unit_number, trailer_id}
 * @returns {{matched:Array, new:Array, missing:Array, conflicting:Array, summary:object}}
 */
function reconcileSnapshot(input) {
  const { snapshotRows = [], trailers = [], aliases = [] } = input;

  const byUnit = new Map(trailers.map((t) => [normalizeUnitNumber(t.unit_number), t]));
  const aliasToTrailer = new Map();
  for (const alias of aliases) {
    const trailer = trailers.find((t) => t.id === alias.trailer_id);
    if (trailer) aliasToTrailer.set(normalizeUnitNumber(alias.alias_unit_number), trailer);
  }

  const snapshotConflicts = detectSnapshotConflicts(snapshotRows);
  // Any unit caught in a snapshot-level conflict must be reviewed as a whole,
  // never silently matched or created.
  const conflictedUnits = new Set(snapshotConflicts.flatMap((c) => c.unit_numbers || []));

  const groups = { matched: [], new: [], missing: [], conflicting: [] };
  const seenTrailerIds = new Set();

  for (const row of snapshotRows) {
    const unit = row.unit_number;
    const rowConflicts = [
      ...snapshotConflicts.filter((c) => (c.unit_numbers || []).includes(unit)),
      ...Object.entries(row.field_conflicts || {}).map(([field, values]) => ({
        type: 'field_disagreement_across_images', field, values,
      })),
    ];

    if (conflictedUnits.has(unit) || rowConflicts.length) {
      const match = byUnit.get(unit) || aliasToTrailer.get(unit) || null;
      if (match) seenTrailerIds.add(match.id);
      groups.conflicting.push({ row, trailer: match, conflicts: rowConflicts });
      continue;
    }

    const direct = byUnit.get(unit);
    if (direct) {
      seenTrailerIds.add(direct.id);
      groups.matched.push({ row, trailer: direct, matched_by: 'unit_number', changes: diffMatched(direct, row) });
      continue;
    }

    const viaAlias = aliasToTrailer.get(unit);
    if (viaAlias) {
      seenTrailerIds.add(viaAlias.id);
      groups.matched.push({ row, trailer: viaAlias, matched_by: 'alias', changes: diffMatched(viaAlias, row) });
      continue;
    }

    groups.new.push({ row, suggestions: suggestSimilar(unit, trailers) });
  }

  // In the database but absent from the complete snapshot. NEVER auto-archived:
  // a human decides Keep / Archive / Correct / Merge.
  for (const trailer of trailers) {
    if (seenTrailerIds.has(trailer.id)) continue;
    if (trailer.master_status === 'archived' || trailer.master_status === 'merged') continue;
    groups.missing.push({
      trailer,
      suggestions: suggestSimilar(trailer.unit_number, snapshotRows.map((r) => ({ id: null, unit_number: r.unit_number }))),
      available_actions: ['keep_verified', 'archive', 'correct_unit', 'merge'],
    });
  }

  return {
    ...groups,
    summary: {
      snapshot_rows: snapshotRows.length,
      matched: groups.matched.length,
      new: groups.new.length,
      missing: groups.missing.length,
      conflicting: groups.conflicting.length,
      requires_review: groups.conflicting.length > 0 || groups.missing.length > 0,
    },
  };
}

module.exports = {
  deduplicateRows,
  detectSnapshotConflicts,
  diffMatched,
  reconcileSnapshot,
  MASTER_FIELDS,
  IDENTITY_CRITICAL_FIELDS,
};
