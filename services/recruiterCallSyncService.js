/**
 * Recruiter call-KPI sync service.
 *
 * Credentials are per-recruiter: either that recruiter's own RingCentral login
 * (an OAuth refresh token, from /ringcentral/connect) or their own JWT token,
 * optionally with their own Client ID/Secret when the number lives under a
 * different RC app (otherwise the shared pair from Settings is used).
 *
 * Sync strategy, per active recruiter:
 *   • own credentials → read that user's OWN extension call log and attribute
 *     every record to the recruiter directly (no number matching needed; works
 *     without an admin-role JWT). Both credential shapes take this path, so
 *     onboarding by signing in to RingCentral never costs a recruiter their
 *     direct attribution.
 *   • no credentials  → covered by ONE shared-credential pass, attributing by
 *     number match (from=outbound, to=inbound). That pass prefers the company
 *     call log (admin-role JWT); when the shared JWT is NOT an admin (403
 *     InsufficientPermissions) it falls back to the shared JWT's own extension
 *     call log — RingCentral extensions can own several direct numbers, so
 *     number matching still attributes those calls to the right recruiters.
 *     Recruiters covered by the per-recruiter pass are excluded here so the
 *     same call is never counted twice (extension and company views assign
 *     different record ids to the same call).
 *
 * Each poll re-fetches from the start of the current day (in the configured
 * timezone) so in-progress calls that finalize later are corrected. Upserts are
 * idempotent (dedup by RC record id).
 */
const { DateTime } = require('luxon');
const rc = require('../database/ringcentral');
const {
  fetchAccountCallLog,
  fetchExtensionCallLog,
  fetchExtensionCallLogWithToken,
} = require('./ringCentralCallService');
const { getRecruiterAccessToken } = require('./ringCentralOAuthService');
const { withRunRecord, noteHeartbeat } = require('./operations/runLedger');

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
  // Resolve each recruiter's auth ONCE — it decrypts up to three columns per
  // row — and partition on the result.
  const resolved = recruiters.map((recruiter) => ({
    recruiter,
    auth: rc.resolveRecruiterRcAuth(recruiter, cfg),
  }));
  const withOwnCreds = resolved.filter((entry) => entry.auth.mode !== 'none');
  const withoutOwnCreds = resolved
    .filter((entry) => entry.auth.mode === 'none')
    .map((entry) => entry.recruiter);

  let synced = 0;
  let attributed = 0;
  const perRecruiter = [];
  const errors = [];

  // ── Per-recruiter pass: each recruiter's own extension call log ──
  for (const { recruiter, auth } of withOwnCreds) {
    if (!auth.clientId || !auth.clientSecret) {
      const msg = `${recruiter.name}: credentials incomplete (missing Client ID/Secret).`;
      errors.push(msg);
      perRecruiter.push({ id: recruiter.id, name: recruiter.name, error: msg });
      continue;
    }
    try {
      const { accessToken } = await getRecruiterAccessToken(recruiter, cfg);
      const records = await fetchExtensionCallLogWithToken({
        apiBase: auth.apiBase, accessToken, dateFrom, dateTo,
      });
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

  // ── Fallback pass: company log for numbers with no credentials of their own ──
  // Recruiters covered above are excluded from attribution here so the same
  // call (different record id in the account view) is never double-counted.
  if (withoutOwnCreds.length) {
    if (cfg.clientId && cfg.clientSecret && cfg.jwtToken) {
      try {
        let records;
        try {
          records = await fetchAccountCallLog({ cfg, dateFrom, dateTo });
        } catch (err) {
          if (err.status !== 403) throw err;
          // Shared JWT lacks the admin role for the company log — read the
          // shared JWT's OWN extension log instead. Its extension may own
          // several direct numbers, so number matching below still attributes
          // correctly for every recruiter whose number lives on that extension.
          console.warn('[RC-SYNC] Company log denied (not admin); using the shared JWT\'s extension log.');
          records = await fetchExtensionCallLog({ cfg, dateFrom, dateTo });
        }
        const rows = attributeCalls(records, withoutOwnCreds);
        const coveredIds = new Set(withOwnCreds.map((entry) => entry.recruiter.id));
        const result = await upsertRows(rows.filter((row) => !coveredIds.has(row.recruiterId)));
        synced += result.synced;
        attributed += result.attributed;
      } catch (err) {
        errors.push(`Shared-credential pass: ${err.message}`);
      }
    } else {
      errors.push(
        `${withoutOwnCreds.length} recruiter(s) have no RingCentral credentials of their own `
        + 'and the shared company credentials are incomplete.'
      );
    }
  }

  if (!withOwnCreds.length && !withoutOwnCreds.length) return { skipped: 'no_recruiters' };

  const errorSummary = errors.length ? errors.join(' | ') : null;
  await rc.markSyncResult({ error: errorSummary }).catch(() => {});
  return { synced, attributed, perRecruiter, errors };
}

async function tick() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    const result = await withRunRecord('recruiter_call_sync', () => syncNow());
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
