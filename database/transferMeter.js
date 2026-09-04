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
 */

/** Warn at these fractions of the budget, once each per month. */
const WARNING_THRESHOLDS = [0.8, 0.9, 0.95];

/** Measure the true size of one result in this many queries. */
const SAMPLE_EVERY = Number.parseInt(process.env.DB_TRANSFER_SAMPLE_EVERY || '25', 10);

/** Weight of a new sample in the bytes-per-row moving average. */
const EMA_ALPHA = 0.2;

/** Rows bigger than this are not walked twice — the sample is truncated. */
const MAX_SAMPLE_ROWS = 200;

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
 * one array element per byte. Sampling a single trailer-media row that way
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
 * Record one completed query.
 *
 * @param {{rows?: Array, rowCount?: number}} result a pg result (or a shape like one)
 */
function recordQuery(result) {
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
}

module.exports = {
  WARNING_THRESHOLDS,
  estimateValueBytes,
  SAMPLE_EVERY,
  currentMonthKey,
  rollMonthIfNeeded,
  recordQuery,
  consumePending,
  recordPending,
  adoptPersisted,
  newlyCrossedThresholds,
  snapshot,
  reset,
};
