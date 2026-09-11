/**
 * The background schedule: check twice a week, drain the outbox often.
 *
 * Two different rhythms, deliberately. Terms do not change hourly, and a
 * watcher that polls like a health check gets rate-limited and switched off —
 * so the CHECK runs on the configured days. Alert DELIVERY is a different
 * problem: an alert that is written must go out promptly and must survive a
 * restart, so the outbox drains on a short interval and its retries are durable.
 *
 * `createDueTimeWakeTimer` is reused rather than a raw setInterval, because it
 * already handles the two things that go wrong with hand-rolled timers here: a
 * tick that throws is caught and retried rather than killing the loop, and the
 * handle is `unref()`d so a shutdown is not held open by a sleeping check.
 */
const { createDueTimeWakeTimer } = require('../../dueTimeWakeTimer');
const policyStore = require('../../../database/aiPolicy');
const { runPolicyCheck } = require('./policyWatcher');
const { drainPolicyAlerts } = require('./alertSender');
const { withRunRecord, noteHeartbeat } = require('../../operations/runLedger');

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
/** Run at 09:00 UTC on a check day — inside a working morning somewhere. */
const CHECK_HOUR_UTC = 9;
const ALERT_POLL_MS = 60_000;

let checkTimer = null;
let alertTimer = null;
let checkRunning = false;

/** When is the next configured check day, from `now`? */
function nextCheckDueAt(checkDays, now = new Date()) {
  const wanted = new Set(
    String(checkDays || 'mon,thu').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean)
  );
  if (!wanted.size) wanted.add('mon');
  for (let ahead = 0; ahead <= 7; ahead += 1) {
    const candidate = new Date(now);
    candidate.setUTCDate(candidate.getUTCDate() + ahead);
    candidate.setUTCHours(CHECK_HOUR_UTC, 0, 0, 0);
    if (candidate > now && wanted.has(DAY_NAMES[candidate.getUTCDay()])) return candidate.getTime();
  }
  return now.getTime() + 24 * 60 * 60 * 1000;
}

async function checkTick() {
  const settings = await policyStore.getWatcherSettings();
  if (!settings.enabled) {
    // Still schedule the next wake: an operator switching it on should not have
    // to restart the process for it to start working. Recorded as `blocked` so
    // "switched off" reads differently from "its timer died".
    await noteHeartbeat('ai_policy_watcher', {
      status: 'blocked', detail: 'the terms watcher is switched off in Settings',
    }).catch(() => {});
    return { dueAtMs: nextCheckDueAt(settings.checkDays) };
  }
  // No overlap. A slow check must not pile up behind itself and diff the same
  // source twice from two different snapshots.
  if (checkRunning) return { dueAtMs: nextCheckDueAt(settings.checkDays) };
  checkRunning = true;
  try {
    await withRunRecord('ai_policy_watcher', () => runPolicyCheck());
  } catch (err) {
    console.error('[POLICY] check failed:', err.message);
  } finally {
    checkRunning = false;
  }
  return { dueAtMs: nextCheckDueAt(settings.checkDays) };
}

function startPolicyWatcher({ telegram = null } = {}) {
  if (checkTimer) return;
  checkTimer = createDueTimeWakeTimer({ label: 'POLICY', runTick: checkTick });
  // A minute after boot, so a deploy does not fire six outbound requests while
  // the process is still warming up.
  checkTimer.start(60_000);

  alertTimer = setInterval(() => {
    drainPolicyAlerts({ telegram }).catch((err) => {
      console.error('[POLICY-ALERT] drain failed:', err.message);
    });
  }, ALERT_POLL_MS);
  alertTimer.unref?.();

  console.log('[POLICY] Terms watcher started.');
}

function stopPolicyWatcher() {
  if (checkTimer) { checkTimer.stop(); checkTimer = null; }
  if (alertTimer) { clearInterval(alertTimer); alertTimer = null; }
}

module.exports = {
  startPolicyWatcher, stopPolicyWatcher, nextCheckDueAt, checkTick,
  DAY_NAMES, CHECK_HOUR_UTC, ALERT_POLL_MS,
};
