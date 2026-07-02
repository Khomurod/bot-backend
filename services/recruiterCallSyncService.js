/**
 * Recruiter call-KPI sync service.
 *
 * Credentials are per-number: each recruiter's RingCentral number has its OWN
 * JWT token (JWTs are per-user), optionally with its own Client ID/Secret when
 * the number lives under a different RC app (otherwise the shared pair from
 * Settings is used).
 *
 * Sync strategy, per active recruiter:
 *   • has a JWT  → read that user's OWN extension call log and attribute every
 *     record to the recruiter directly (no number matching needed; works
 *     without an admin-role JWT).
 *   • no JWT     → covered by ONE company call-log pass using the shared
 *     credentials, attributing by number match (from=outbound, to=inbound).
 *     In that pass, JWT-holding recruiters are excluded from attribution so the
 *     same call is never counted twice (extension and company views assign
 *     different record ids to the same call).
 *
 * Each poll re-fetches from the start of the current day (in the configured
 * timezone) so in-progress calls that finalize later are corrected. Upserts are
 * idempotent (dedup by RC record id).
 */
const { DateTime } = require('luxon');
const rc = require('../database/ringcentral');
const { fetchAccountCallLog, fetchExtensionCallLog } = require('./ringCentralCallService');

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
 * Map records from a recruiter's OWN extension call log — every record belongs
 * to that recruiter, so attribution is direct. Pure function for tests.
 */
function mapExtensionCalls(records, recruiter) {
  const rows = [];
  for (const rec of Array.isArray(records) ? records : []) {
    if (rec?.type && rec.type !== 'Voice') continue;
    rows.push({
      id: rec.id,
      sessionId: rec.sessionId || null,
      recruiterId: recruiter.id,
      recruiterNumberNormalized: recruiter.phone_number_normalized || null,
      direction: rec.direction || null,
      result: rec.result || null,
      fromNumber: pickPhone(rec?.from),
      toNumber: pickPhone(rec?.to),
      durationSeconds: Number.isFinite(rec.duration) ? rec.duration : 0,
      callTime: rec.startTime || null,
    });
  }
  return rows;
}

async function upsertRows(rows) {
  let synced = 0;
  let attributed = 0;
  for (const row of rows) {
    if (!row.id || !row.callTime) continue;
    await rc.upsertCall(row);
    synced += 1;
    if (row.recruiterId) attributed += 1;
  }
  return { synced, attributed };
}

/**
 * Run one sync pass. Returns { synced, attributed, perRecruiter, errors }.
 * `full` widens the window to 7 days (manual backfill).
 */
async function syncNow({ full = false } = {}) {
  const cfg = await rc.getRcConfig();
  if (!cfg.enabled) return { skipped: 'disabled' };

  const tz = cfg.timezone || 'America/Chicago';
  const now = DateTime.now().setZone(tz);
  const start = full ? now.minus({ days: 7 }).startOf('day') : now.startOf('day');
  const dateFrom = start.toUTC().toISO();
  const dateTo = now.toUTC().toISO();

  const recruiters = await rc.listRecruiters({ includeInactive: false });
  const withJwt = recruiters.filter((r) => r.jwt_token_encrypted);
  const withoutJwt = recruiters.filter((r) => !r.jwt_token_encrypted);

  let synced = 0;
  let attributed = 0;
  const perRecruiter = [];
  const errors = [];

  // ── Per-number pass: each recruiter's own extension call log ──
  for (const recruiter of withJwt) {
    const auth = rc.resolveRecruiterRcAuth(recruiter, cfg);
    if (!auth.clientId || !auth.clientSecret || !auth.jwtToken) {
      const msg = `${recruiter.name}: credentials incomplete (missing ${!auth.jwtToken ? 'JWT' : 'Client ID/Secret'}).`;
      errors.push(msg);
      perRecruiter.push({ id: recruiter.id, name: recruiter.name, error: msg });
      continue;
    }
    try {
      const records = await fetchExtensionCallLog({ cfg: auth, dateFrom, dateTo });
      const rows = mapExtensionCalls(records, recruiter);
      const result = await upsertRows(rows);
      synced += result.synced;
      attributed += result.attributed;
      perRecruiter.push({ id: recruiter.id, name: recruiter.name, synced: result.synced });
    } catch (err) {
      errors.push(`${recruiter.name}: ${err.message}`);
      perRecruiter.push({ id: recruiter.id, name: recruiter.name, error: err.message });
    }
  }

  // ── Fallback pass: company log for numbers without their own JWT ──
  // JWT-holding recruiters are excluded from attribution here so the same call
  // (different record id in the account view) is never double-counted.
  if (withoutJwt.length) {
    if (cfg.clientId && cfg.clientSecret && cfg.jwtToken) {
      try {
        const records = await fetchAccountCallLog({ cfg, dateFrom, dateTo });
        const rows = attributeCalls(records, withoutJwt);
        const jwtIds = new Set(withJwt.map((r) => r.id));
        const result = await upsertRows(rows.filter((row) => !jwtIds.has(row.recruiterId)));
        synced += result.synced;
        attributed += result.attributed;
      } catch (err) {
        errors.push(`Company log: ${err.message}`);
      }
    } else {
      errors.push(
        `${withoutJwt.length} recruiter(s) have no JWT and the shared company credentials are incomplete.`
      );
    }
  }

  if (!withJwt.length && !withoutJwt.length) return { skipped: 'no_recruiters' };

  const errorSummary = errors.length ? errors.join(' | ') : null;
  await rc.markSyncResult({ error: errorSummary }).catch(() => {});
  return { synced, attributed, perRecruiter, errors };
}

async function tick() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    const result = await syncNow();
    if (result?.synced != null) {
      const errNote = result.errors?.length ? ` (${result.errors.length} error(s))` : '';
      console.log(`[RC-SYNC] Synced ${result.synced} call(s), ${result.attributed} attributed${errNote}.`);
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
  mapExtensionCalls,
  syncNow,
  startRecruiterCallSyncService,
  stopRecruiterCallSyncService,
};
