'use strict';

/**
 * Persisting and reporting the monthly database-transfer estimate.
 *
 * The counters live in database/transferMeter.js (in memory, no I/O). This
 * module is the one that touches the database: it flushes the accumulated
 * numbers into `database_transfer_usage` at most once a minute, reads the
 * month's row back on boot so a Render restart does not zero the estimate, and
 * turns the counters into the report the admin panel warns from.
 *
 * WHY IT MATTERS. This deployment reached 4.222 GB of a 5 GB monthly transfer
 * allowance with nothing in the application aware of it. Running out is not
 * graceful — reads simply start failing — so the point of this module is to say
 * "you are at 90%" while there is still time to act.
 *
 * A FAILED FLUSH LOSES NOTHING: pending counters are put back so the next flush
 * carries them. And it never throws into a caller — usage accounting must not
 * be able to break a request.
 */

const { query } = require('./pool');
const meter = require('./transferMeter');

/** Warn once per threshold per month, in the server log. */
const WARNING_LABELS = { 0.8: '80%', 0.9: '90%', 0.95: '95%' };

/** Write the accumulated counters into this month's row. */
async function flushUsage() {
  const pending = meter.consumePending();
  if (!pending.bytes && !pending.queries) return { written: false };
  try {
    await query(
      `INSERT INTO database_transfer_usage (month_key, bytes_estimated, queries, rows_read, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (month_key) DO UPDATE SET
         bytes_estimated = database_transfer_usage.bytes_estimated + EXCLUDED.bytes_estimated,
         queries         = database_transfer_usage.queries + EXCLUDED.queries,
         rows_read       = database_transfer_usage.rows_read + EXCLUDED.rows_read,
         updated_at      = NOW()`,
      [pending.monthKey, pending.bytes, pending.queries, pending.rows],
    );
    return { written: true, ...pending };
  } catch (err) {
    // Put them back rather than losing the month's accounting to one bad write
    // (the likeliest cause of that write failing is the very outage or quota
    // problem this meter exists to warn about).
    meter.recordPending(pending);
    console.warn('[DB-USAGE] Could not persist transfer usage:', err.message);
    return { written: false, error: err.message };
  }
}

/** Adopt the stored total for the current month. Safe before the table exists. */
async function loadPersistedUsage() {
  const monthKey = meter.currentMonthKey();
  try {
    const res = await query(
      `SELECT bytes_estimated, queries, rows_read FROM database_transfer_usage WHERE month_key = $1`,
      [monthKey],
    );
    const row = res.rows[0];
    if (!row) return { loaded: false, monthKey };
    meter.adoptPersisted({
      monthKey,
      bytes: Number(row.bytes_estimated) || 0,
      queries: Number(row.queries) || 0,
      rows: Number(row.rows_read) || 0,
    });
    return { loaded: true, monthKey, bytes: Number(row.bytes_estimated) || 0 };
  } catch (err) {
    // A fresh database has not run migration 0007 yet, and a meter that cannot
    // read its history must still count from now on.
    console.warn('[DB-USAGE] Could not read stored transfer usage:', err.message);
    return { loaded: false, monthKey, error: err.message };
  }
}

const GB = 1024 * 1024 * 1024;

/**
 * The report the admin panel and the log warnings read.
 *
 * `estimated: true` is part of the payload on purpose — whoever sees a
 * percentage must know it came from this app's sampling, not from the
 * provider's billing page.
 */
function usageReport({ budgetBytes }) {
  const snapshot = meter.snapshot();
  const budget = Number(budgetBytes) > 0 ? Number(budgetBytes) : 5 * GB;
  const fraction = budget > 0 ? snapshot.bytes / budget : 0;
  return {
    monthKey: snapshot.monthKey,
    estimated: true,
    bytes: snapshot.bytes,
    gigabytes: Number((snapshot.bytes / GB).toFixed(3)),
    budgetBytes: budget,
    budgetGigabytes: Number((budget / GB).toFixed(3)),
    percent: Number((fraction * 100).toFixed(1)),
    level: levelFor(fraction),
    queries: snapshot.queries,
    rows: snapshot.rows,
    thresholds: meter.WARNING_THRESHOLDS,
  };
}

/** ok → warning (80%) → high (90%) → critical (95%). */
function levelFor(fraction) {
  if (fraction >= 0.95) return 'critical';
  if (fraction >= 0.9) return 'high';
  if (fraction >= 0.8) return 'warning';
  return 'ok';
}

/**
 * Log a warning the first time each threshold is crossed in a month.
 * Returns the thresholds that were newly crossed.
 */
function reportThresholds({ budgetBytes }) {
  const report = usageReport({ budgetBytes });
  const crossed = meter.newlyCrossedThresholds(report.percent / 100);
  for (const threshold of crossed) {
    console.warn(
      `[DB-USAGE] Estimated database transfer for ${report.monthKey} has passed `
      + `${WARNING_LABELS[threshold] || `${threshold * 100}%`} of the `
      + `${report.budgetGigabytes} GB monthly budget `
      + `(~${report.gigabytes} GB across ${report.queries} queries). `
      + 'This is this application\'s own estimate; check the provider dashboard '
      + 'for the billed figure.',
    );
  }
  return crossed;
}

module.exports = { flushUsage, loadPersistedUsage, usageReport, reportThresholds, levelFor, GB };
