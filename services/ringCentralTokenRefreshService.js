'use strict';

/**
 * Keeps every recruiter's RingCentral login alive.
 *
 * A RingCentral authorization-code REFRESH TOKEN expires in 7 days, and each
 * refresh issues a new one. Nothing in the lead flow is guaranteed to touch a
 * given recruiter inside any 7-day window — a recruiter can easily go a week
 * without being assigned a lead — so without this job their login would expire
 * from disuse and their leads would start going out from the shared number,
 * silently, on a Monday nobody was watching.
 *
 * The job is deliberately dull: once a day (and once at boot, because a restart
 * may follow days of downtime), refresh each stored token and store the
 * rotation. A failure is recorded on the recruiter row — `rc_auth_error` is what
 * the admin panel renders as "needs to connect RingCentral again" — and never
 * retried in a tight loop: an expired grant is fixed by a person, not a retry.
 *
 * IT ALSO BACKFILLS THE EXTENSION IDENTITY. `rc_extension_id` was only ever
 * written by the OAuth sign-in callback, so a recruiter onboarded with a pasted
 * JWT had none — and the inbound-SMS subscription is built one filter per
 * extension id, so their drivers' replies reached nobody while their outbound
 * texts worked perfectly. This is the right place for the repair: the job
 * already walks every credentialed recruiter, it runs once at boot (so a deploy
 * fixes production in minutes rather than a day), and the read costs one
 * request for a recruiter who is missing it and nothing at all for everyone
 * else.
 *
 * Runs server-side on its own timer, so it does not depend on anyone having the
 * admin panel open.
 */
const rc = require('../database/ringcentral');
const { refreshRecruiterTokens } = require('./ringCentralOAuthService');
const { needsExtensionIdentity, backfillExtensionIdentity } = require('./recruiterExtensionIdentity');

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Small stagger between recruiters so a dozen refreshes are not one burst. */
const PER_RECRUITER_DELAY_MS = 250;

let timer = null;
let stopped = true;
let running = false;

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });
}

/**
 * Refresh every stored recruiter refresh token once.
 *
 * @returns {Promise<{checked:number, refreshed:number, failed:number,
 *   identified:number, missingIdentity:number, needsLogin:string[],
 *   errors:string[]}>}
 */
async function refreshAllRecruiterTokens({ delayMs = PER_RECRUITER_DELAY_MS } = {}) {
  const summary = {
    checked: 0, refreshed: 0, failed: 0, identified: 0, missingIdentity: 0,
    needsLogin: [], errors: [],
  };

  let recruiters = [];
  try {
    recruiters = await rc.listRecruitersWithOwnCredentials();
  } catch (err) {
    summary.errors.push(`Could not list recruiters: ${err.message}`);
    return summary;
  }

  const cfg = await rc.getRcConfig().catch(() => null);
  if (!cfg) {
    summary.errors.push('RingCentral settings unavailable.');
    return summary;
  }

  for (const recruiter of recruiters) {
    const auth = rc.resolveRecruiterRcAuth(recruiter, cfg);
    if (auth.mode === 'none') continue;

    // JWTs do not expire, so there is nothing to keep alive for those rows —
    // but they DO still need an extension identity, which is why the identity
    // step below sits outside this branch.
    let credentialUsable = true;
    if (auth.mode === 'oauth') {
      summary.checked += 1;
      try {
        await refreshRecruiterTokens(recruiter, auth);
        summary.refreshed += 1;
      } catch (err) {
        summary.failed += 1;
        credentialUsable = false;
        if (err.code === 'RC_REFRESH_EXPIRED') summary.needsLogin.push(recruiter.name || `#${recruiter.id}`);
        else summary.errors.push(`${recruiter.name || `#${recruiter.id}`}: ${err.message}`);
      }
    }

    // Only for a recruiter who is missing it, and only with a credential that
    // just worked — asking with a grant we know is dead would just log a
    // second, confusing failure for the same recruiter.
    if (credentialUsable && needsExtensionIdentity(recruiter)) {
      summary.missingIdentity += 1;
      try {
        if (await backfillExtensionIdentity(recruiter, cfg)) summary.identified += 1;
      } catch (err) {
        summary.errors.push(
          `${recruiter.name || `#${recruiter.id}`}: could not read their RingCentral extension `
          + `(their drivers' replies will not be mirrored until this succeeds): ${err.message}`
        );
      }
    }

    if (delayMs > 0) await sleep(delayMs);
  }

  return summary;
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const summary = await refreshAllRecruiterTokens();
    if (summary.checked) {
      const needs = summary.needsLogin.length
        ? ` — must re-connect RingCentral: ${summary.needsLogin.join(', ')}`
        : '';
      console.log(
        `[RC-TOKENS] Refreshed ${summary.refreshed}/${summary.checked} recruiter login(s), `
        + `${summary.failed} failed${needs}`
      );
    }
    if (summary.missingIdentity) {
      console.log(
        `[RC-TOKENS] Recorded the RingCentral extension for ${summary.identified}/`
        + `${summary.missingIdentity} recruiter(s) that had none. Until a recruiter has one, `
        + 'the inbound-SMS subscription cannot watch their number and replies to it are not mirrored.'
      );
    }
    for (const message of summary.errors) console.warn('[RC-TOKENS]', message);
  } catch (err) {
    console.warn('[RC-TOKENS] tick failed:', err.message);
  } finally {
    running = false;
  }
}

function scheduleNext(intervalMs) {
  if (stopped) return;
  timer = setTimeout(async () => {
    await tick();
    scheduleNext(REFRESH_INTERVAL_MS);
  }, intervalMs);
  timer.unref?.();
}

function startRingCentralTokenRefreshService() {
  stopped = false;
  console.log('[RC-TOKENS] Recruiter RingCentral login refresh started (daily).');
  (async () => {
    await tick();
    scheduleNext(REFRESH_INTERVAL_MS);
  })();
}

function stopRingCentralTokenRefreshService() {
  stopped = true;
  if (timer) { clearTimeout(timer); timer = null; }
  console.log('[RC-TOKENS] Recruiter RingCentral login refresh stopped.');
}

module.exports = {
  REFRESH_INTERVAL_MS,
  refreshAllRecruiterTokens,
  startRingCentralTokenRefreshService,
  stopRingCentralTokenRefreshService,
};
