'use strict';

/**
 * How much data this application has read out of the database this month.
 *
 * WHY IT EXISTS. The deployment sits on a hosted PostgreSQL (Supabase) with a
 * monthly data-transfer allowance, and the first anyone knew of being near it
 * was 4.2 GB of 5 GB showing on a dashboard nobody was watching. Running out
 * does not degrade gracefully: reads start failing, and the app has no way to
 * tell that apart from an outage. A meter plus early warnings is the cheap
 * protection — it cannot enforce the provider's limit, but it can say "you are
 * at 90%" while there is still time to act.
 *
 * IT IS AN ESTIMATE, AND IT SAYS SO. Postgres does not report the bytes it put
 * on the wire, so this measures the serialized size of result rows and
 * extrapolates from a sample (measuring every result would double the work of
 * every large query). Sampled rows feed a moving average of bytes-per-row, and
 * unsampled queries are counted as rowCount × that average. Expect the right
 * order of magnitude and a trustworthy TREND, not the provider's invoice.
 *
 * NO I/O HERE. This module holds the accumulator and the threshold state only,
 * so the database boundary (database/pool.js) can call it on every query
 * without a circular dependency. database/transferUsage.js owns persistence.
 * Its one import is a pure `lib/` helper, which is the layer BELOW this one.
 */

const { labelForQuery } = require('../lib/database/queryLabel');

/** Warn at these fractions of the budget, once each per month. */
const WARNING_THRESHOLDS = [0.8, 0.9, 0.95];

/** Measure the true size of one result in this many queries. */
const SAMPLE_EVERY = Number.parseInt(process.env.DB_TRANSFER_SAMPLE_EVERY || '25', 10);

/** Weight of a new sample in the bytes-per-row moving average. */
const EMA_ALPHA = 0.2;

/** Rows bigger than this are not walked twice — the sample is truncated. */
const MAX_SAMPLE_ROWS = 200;

/**
 * How many tables are named before the rest become one `other` row.
 *
 * A DIAGNOSTIC THAT GROWS WITHOUT LIMIT IS A MEMORY LEAK WEARING A CHART. The
 * labels can only come from this repository's own SQL, so the set is finite —
 * but "finite" and "bounded" are different promises, and this module runs on
 * every query for the life of the process. Whatever is already named keeps
 * accumulating; anything new past the cap joins `other`, so the parts still
 * sum to the total and the answer degrades into a coarser one rather than a
 * wrong one.
 */
const MAX_LABELS = Number.parseInt(process.env.DB_TRANSFER_MAX_LABELS || '80', 10);

const state = {
  monthKey: currentMonthKey(),
  /** Bytes attributed to this month, including whatever was loaded from the DB. */
  totalBytes: 0,
  totalQueries: 0,
  totalRows: 0,
  /** Not yet written to the usage table. */
  pendingBytes: 0,
  pendingQueries: 0,
  pendingRows: 0,
  /** Moving average of bytes per row, seeded from a typical admin row. */
  bytesPerRow: 400,
  queriesSinceSample: 0,
  notifiedThresholds: [],
  /**
   * Per-table totals for THIS PROCESS, `label -> {bytes, queries, rows}`.
   *
   * Deliberately NOT persisted and deliberately not part of the month's
   * running total. The monthly figure has to survive a restart, which is why
   * it is written to a table; attribution answers "what is spending it right
   * now", and a share carried across a deploy would describe a process that no
   * longer exists. Restarting resets the breakdown and never the total.
   */
  byLabel: new Map(),
  labelsSince: Date.now(),
};

/** UTC month, matching how a provider bills — `2026-09`. */
function currentMonthKey(now = new Date()) {
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${now.getUTCFullYear()}-${month}`;
}

/** How deep into nested JSONB the estimator walks before assuming a size. */
const MAX_SAMPLE_DEPTH = 3;

/**
 * Approximate wire size of one value, WITHOUT serializing it.
 *
 * `JSON.stringify` is deliberately not used: a `bytea` column arrives as a
 * Buffer, and stringifying one expands it to `{"type":"Buffer","data":[…]}` —
 * one array element per byte. Sampling a single media-bearing row that way
 * could allocate hundreds of megabytes on a 512 MB instance, which is a
 * spectacular way for a usage meter to take down the app it measures. A Buffer
 * is counted by `.length` instead, and the depth cap also means a circular
 * object terminates rather than looping.
 */
function estimateValueBytes(value, depth = 0) {
  if (value === null || value === undefined) return 1;
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  if (typeof value === 'number') return 8;
  if (typeof value === 'boolean') return 1;
  if (typeof value === 'bigint') return 8;
  if (Buffer.isBuffer(value)) return value.length;
  if (value instanceof Date) return 8;
  if (depth >= MAX_SAMPLE_DEPTH) return 64;
  if (Array.isArray(value)) {
    let total = 2;
    for (const item of value) total += estimateValueBytes(item, depth + 1) + 1;
    return total;
  }
  if (typeof value === 'object') {
    let total = 2;
    for (const [key, item] of Object.entries(value)) {
      total += key.length + 3 + estimateValueBytes(item, depth + 1);
    }
    return total;
  }
  return 8;
}

/** Approximate size of up to MAX_SAMPLE_ROWS rows, extrapolated to all of them. */
function measureRows(rows) {
  const sample = rows.length > MAX_SAMPLE_ROWS ? rows.slice(0, MAX_SAMPLE_ROWS) : rows;
  let bytes = 0;
  for (const row of sample) bytes += estimateValueBytes(row);
  if (rows.length > sample.length && sample.length > 0) {
    bytes = Math.round((bytes / sample.length) * rows.length);
  }
  return bytes;
}

/**
 * A new month starts a new budget; the old counters are gone.
 *
 * Up to one flush interval (a minute) of the outgoing month's traffic is
 * dropped rather than carried across the boundary. That is deliberate: the
 * numbers are an estimate for a warning threshold, and a minute of
 * misattribution once a month is not worth machinery to avoid.
 */
function rollMonthIfNeeded(now = new Date()) {
  const key = currentMonthKey(now);
  if (key === state.monthKey) return false;
  state.monthKey = key;
  state.totalBytes = 0;
  state.totalQueries = 0;
  state.totalRows = 0;
  state.pendingBytes = 0;
  state.pendingQueries = 0;
  state.pendingRows = 0;
  state.notifiedThresholds = [];
  return true;
}

/**
 * Attribute one query's bytes to the table it named.
 *
 * Never throws and never grows past `MAX_LABELS`: a table already being
 * counted keeps its own row, and anything new past the cap lands in `other`,
 * so the parts always sum to the whole.
 */
function attribute(label, bytes, rowCount) {
  const key = state.byLabel.has(label) || state.byLabel.size < MAX_LABELS ? label : 'other';
  const entry = state.byLabel.get(key) || { bytes: 0, queries: 0, rows: 0 };
  entry.bytes += bytes;
  entry.queries += 1;
  entry.rows += rowCount;
  state.byLabel.set(key, entry);
}

/**
 * The breakdown, biggest first.
 *
 * `share` is of the process's attributed bytes, NOT of the month: the month
 * survives restarts and this does not, and a percentage mixing the two would
 * be a number that means nothing on either scale.
 */
function usageByLabel({ limit = 10 } = {}) {
  const rows = [...state.byLabel.entries()]
    .map(([label, v]) => ({ label, ...v }))
    .sort((a, b) => b.bytes - a.bytes);
  const attributed = rows.reduce((sum, r) => sum + r.bytes, 0);
  return {
    since: new Date(state.labelsSince).toISOString(),
    attributedBytes: attributed,
    tables: rows.slice(0, limit).map((r) => ({
      ...r,
      share: attributed > 0 ? Math.round((r.bytes / attributed) * 1000) / 1000 : 0,
    })),
    // Named so a reader can tell "these ARE all of them" from "these are the
    // ten biggest of ninety", which changes what the shares mean.
    truncated: rows.length > limit,
  };
}

/**
 * Record one completed query.
 *
 * @param {{rows?: Array, rowCount?: number}} result a pg result (or a shape like one)
 * @param {string} [text] the SQL, used ONLY to name the table it touched
 */
function recordQuery(result, text) {
  rollMonthIfNeeded();
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  const rowCount = Number.isFinite(result?.rowCount) ? result.rowCount : rows.length;

  state.queriesSinceSample += 1;
  let bytes = null;
  if (rows.length && state.queriesSinceSample >= SAMPLE_EVERY) {
    state.queriesSinceSample = 0;
    bytes = measureRows(rows);
    if (bytes != null && rows.length > 0) {
      const perRow = bytes / rows.length;
      state.bytesPerRow = (EMA_ALPHA * perRow) + ((1 - EMA_ALPHA) * state.bytesPerRow);
    }
  }
  if (bytes == null) {
    // Estimated from the moving average. The +200 is the protocol and row
    // overhead every query pays even when it returns nothing.
    bytes = Math.round((rowCount * state.bytesPerRow) + 200);
  }

  state.totalBytes += bytes;
  state.totalQueries += 1;
  state.totalRows += rowCount;
  state.pendingBytes += bytes;
  state.pendingQueries += 1;
  state.pendingRows += rowCount;

  // Attribution is additive and best-effort: it must never be able to change
  // the total above, which is the number the warnings fire on.
  try {
    attribute(labelForQuery(text), bytes, rowCount);
  } catch (_) {
    // A breakdown is a nicety; the meter is not.
  }
  return bytes;
}

/** Everything not yet persisted, cleared in one step so nothing double-counts. */
function consumePending() {
  const pending = {
    monthKey: state.monthKey,
    bytes: state.pendingBytes,
    queries: state.pendingQueries,
    rows: state.pendingRows,
  };
  state.pendingBytes = 0;
  state.pendingQueries = 0;
  state.pendingRows = 0;
  return pending;
}

/**
 * Put pending counters back after a failed flush, so a write that could not
 * reach the database does not silently erase the month's accounting.
 */
function recordPending({ monthKey, bytes = 0, queries = 0, rows = 0 } = {}) {
  if (monthKey && monthKey !== state.monthKey) return false;
  state.pendingBytes += Number(bytes) || 0;
  state.pendingQueries += Number(queries) || 0;
  state.pendingRows += Number(rows) || 0;
  return true;
}

/**
 * Adopt the persisted totals for a month (called once on boot, so a restart
 * does not reset the month's estimate to zero).
 */
function adoptPersisted({ monthKey, bytes = 0, queries = 0, rows = 0 } = {}) {
  if (!monthKey || monthKey !== state.monthKey) return false;
  state.totalBytes = Math.max(state.totalBytes, Number(bytes) || 0);
  state.totalQueries = Math.max(state.totalQueries, Number(queries) || 0);
  state.totalRows = Math.max(state.totalRows, Number(rows) || 0);
  return true;
}

/** Which warning thresholds this fraction has newly crossed, at most once each. */
function newlyCrossedThresholds(fraction) {
  const crossed = WARNING_THRESHOLDS.filter(
    (t) => fraction >= t && !state.notifiedThresholds.includes(t),
  );
  state.notifiedThresholds.push(...crossed);
  return crossed;
}

/** The current counters. Read-only copy. */
function snapshot() {
  return {
    monthKey: state.monthKey,
    bytes: state.totalBytes,
    queries: state.totalQueries,
    rows: state.totalRows,
    bytesPerRow: Math.round(state.bytesPerRow),
    pendingBytes: state.pendingBytes,
  };
}

/** Test helper: forget everything. */
function reset(now = new Date()) {
  state.monthKey = currentMonthKey(now);
  state.totalBytes = 0;
  state.totalQueries = 0;
  state.totalRows = 0;
  state.pendingBytes = 0;
  state.pendingQueries = 0;
  state.pendingRows = 0;
  state.bytesPerRow = 400;
  state.queriesSinceSample = 0;
  state.notifiedThresholds = [];
  state.byLabel = new Map();
  state.labelsSince = now instanceof Date ? now.getTime() : Date.now();
}

module.exports = {
  WARNING_THRESHOLDS,
  estimateValueBytes,
  SAMPLE_EVERY,
  currentMonthKey,
  rollMonthIfNeeded,
  recordQuery,
  usageByLabel,
  consumePending,
  recordPending,
  adoptPersisted,
  newlyCrossedThresholds,
  snapshot,
  reset,
};
