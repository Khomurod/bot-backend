/**
 * Recruiter call-KPI sync service.
 *
 * Polls the RingCentral company Call Log, attributes each Voice call to a
 * recruiter by matching the recruiter's dedicated direct number (from-number for
 * outbound, to-number for inbound), and upserts the raw records. KPIs are then
 * computed on demand from the stored records (see database/ringcentral.js).
 *
 * Each poll re-fetches from the start of the current day (in the configured
 * timezone) so in-progress calls that finalize later are corrected, and the
 * rollup for "today" is always complete. Upserts are idempotent (dedup by RC id).
 */
const { DateTime } = require('luxon');
const rc = require('../database/ringcentral');
const { fetchAccountCallLog } = require('./ringCentralCallService');

let schedulerTimer = null;
let schedulerStopped = true;
let tickRunning = false;

function pickPhone(party) {
  return party?.phoneNumber || party?.extensionNumber || null;
}

/**
 * Map raw RingCentral records to normalized call rows, attributing each to a
 * recruiter. Pure function (recruiter list injected) so it is unit-testable.
 */
function attributeCalls(records, recruiters) {
  const byNumber = new Map();
  for (const r of recruiters) {
    if (r.phone_number_normalized) byNumber.set(r.phone_number_normalized, r);
  }

  const rows = [];
  for (const rec of Array.isArray(records) ? records : []) {
    if (rec?.type && rec.type !== 'Voice') continue;
    const direction = rec?.direction || null;
    const fromNumber = pickPhone(rec?.from);
    const toNumber = pickPhone(rec?.to);
    // Outbound: the recruiter is the caller (from). Inbound: the callee (to).
    const recruiterRaw = direction === 'Outbound' ? fromNumber
      : direction === 'Inbound' ? toNumber
        : null;
    const recruiterNorm = rc.normalizePhone(recruiterRaw);
    const recruiter = recruiterNorm ? byNumber.get(recruiterNorm) : null;

    rows.push({
      id: rec.id,
      sessionId: rec.sessionId || null,
      recruiterId: recruiter ? recruiter.id : null,
      recruiterNumberNormalized: recruiter ? recruiterNorm : null,
      direction,
      result: rec.result || null,
      fromNumber,
      toNumber,
      durationSeconds: Number.isFinite(rec.duration) ? rec.duration : 0,
      callTime: rec.startTime || null,
    });
  }
  return rows;
}

/**
 * Run one sync pass. Returns { synced, attributed } or throws.
 * `sinceStartOfDay` (default true) fetches from midnight in the configured tz.
 */
async function syncNow({ full = false } = {}) {
  const cfg = await rc.getRcConfig();
  if (!cfg.enabled) return { skipped: 'disabled' };
  if (!cfg.clientId || !cfg.clientSecret || !cfg.jwtToken) return { skipped: 'not_configured' };

  const tz = cfg.timezone || 'America/Chicago';
  const now = DateTime.now().setZone(tz);
  // `full` widens the window to 7 days (used by a manual backfill button).
  const start = full ? now.minus({ days: 7 }).startOf('day') : now.startOf('day');
  const dateFrom = start.toUTC().toISO();
  const dateTo = now.toUTC().toISO();

  try {
    const records = await fetchAccountCallLog({ cfg, dateFrom, dateTo });
    const recruiters = await rc.listRecruiters({ includeInactive: true });
    const rows = attributeCalls(records, recruiters);

    let attributed = 0;
    for (const row of rows) {
      if (!row.id || !row.callTime) continue;
      await rc.upsertCall(row);
      if (row.recruiterId) attributed += 1;
    }
    await rc.markSyncResult({ error: null });
    return { synced: rows.length, attributed };
  } catch (err) {
    await rc.markSyncResult({ error: err.message }).catch(() => {});
    throw err;
  }
}

async function tick() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    const result = await syncNow();
    if (result?.synced != null) {
      console.log(`[RC-SYNC] Synced ${result.synced} call(s), ${result.attributed} attributed.`);
    }
  } catch (err) {
    console.warn('[RC-SYNC] tick failed:', err.message);
  } finally {
    tickRunning = false;
  }
}

function scheduleNextTick(intervalMs) {
  if (schedulerStopped) return;
  schedulerTimer = setTimeout(async () => {
    await tick();
    const cfg = await rc.getRcConfig().catch(() => ({ pollMinutes: 10 }));
    scheduleNextTick(Math.max(1, cfg.pollMinutes || 10) * 60_000);
  }, intervalMs);
  schedulerTimer.unref?.();
}

function startRecruiterCallSyncService() {
  schedulerStopped = false;
  console.log('[RC-SYNC] Recruiter call sync service started.');
  (async () => {
    const cfg = await rc.getRcConfig().catch(() => ({ pollMinutes: 10 }));
    await tick();
    scheduleNextTick(Math.max(1, cfg.pollMinutes || 10) * 60_000);
  })();
}

function stopRecruiterCallSyncService() {
  schedulerStopped = true;
  if (schedulerTimer) { clearTimeout(schedulerTimer); schedulerTimer = null; }
  console.log('[RC-SYNC] Recruiter call sync service stopped.');
}

module.exports = {
  attributeCalls,
  syncNow,
  startRecruiterCallSyncService,
  stopRecruiterCallSyncService,
};
