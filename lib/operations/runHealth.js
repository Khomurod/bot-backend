'use strict';

/**
 * What a background worker's last run says about it. PURE.
 *
 * THE QUESTION THIS ANSWERS is the one `/api/health` could not: has this worker
 * actually run, or has its timer been dead since a deploy nobody noticed? Those
 * two look identical from every table the worker writes, because a pass that
 * finds nothing writes nothing — and this application has already lost weeks of
 * staff alerts to exactly that ambiguity.
 *
 * SEVEN STATES, and they are seven because collapsing any pair loses a decision
 * somebody has to make:
 *
 *   healthy                 ran, recently, without error.
 *   degraded                failed, but not enough times to mean anything yet.
 *                           Integrations blip; a provider 503s and the next
 *                           call succeeds. Announcing this is how a channel
 *                           becomes unread.
 *   repeatedly_failing      failed consistently. Real, and still inside what
 *                           the application recovers from on its own.
 *   stale_stopped           has not finished a pass in several of its own
 *                           intervals. THE ONE NOTHING ELSE CAN SEE: the worker
 *                           is not failing, it is not running, and every table
 *                           it owns looks merely quiet.
 *   recovered_automatically ran clean after failing. Worth saying once, and
 *                           only to people who were told it broke.
 *   needs_human_attention   cannot proceed without a person — either blocked on
 *                           configuration nobody has supplied, or failing for
 *                           long enough that the automatic recovery has been
 *                           given its chance and did not work.
 *   cannot_determine        no record at all, or not due yet. NOT healthy.
 *                           "I could not check" must never render as "fine";
 *                           that is the failure mode this whole file exists to
 *                           remove, and it would be ironic to reintroduce it in
 *                           the classifier.
 *
 * `blocked` deserves its own note. A worker that cannot run because an operator
 * has not configured a Telegram group or an API key is NOT broken, and painting
 * it red is how a real outage gets lost among things that were never switched
 * on. It maps to `needs_human_attention` with a reason that names the missing
 * thing — and it is the only state that says what to do.
 */

const { classifyErrorKind, describeErrorKind } = require('./errorKind');

const RUN_STATES = Object.freeze({
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  FAILING: 'repeatedly_failing',
  STALE: 'stale_stopped',
  RECOVERED: 'recovered_automatically',
  NEEDS_ATTENTION: 'needs_human_attention',
  UNKNOWN: 'cannot_determine',
});

/** The states that mean somebody should look. Everything else is information. */
const ACTIONABLE = Object.freeze([
  RUN_STATES.FAILING, RUN_STATES.STALE, RUN_STATES.NEEDS_ATTENTION,
]);

const DEFAULTS = Object.freeze({
  /** Failures before "it blipped" becomes "it is failing". */
  failuresBeforeFailing: 3,
  /** Failures before the automatic recovery has demonstrably not worked. */
  failuresBeforeHuman: 8,
  /**
   * How many of its own intervals a worker may miss before it has stopped.
   *
   * Three, not one: a pass whose interval is twenty minutes and which sometimes
   * takes twenty-five is not stopped, and a threshold that calls it stopped
   * teaches everyone to ignore the word.
   */
  staleIntervals: 3,
  /** Never call a fast worker stale sooner than this. */
  minStaleSeconds: 15 * 60,
  /** However slow the worker, silence this long is silence. */
  maxStaleSeconds: 3 * 24 * 3600,
  /** A clean run this recently after failures is a recovery worth saying. */
  recoveryWindowSeconds: 6 * 3600,
});

function toMs(value) {
  const t = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
}

/** How long a worker may be silent before it counts as stopped, in ms. */
function staleAfterMs(expectedIntervalSeconds, opts = DEFAULTS) {
  const interval = Number(expectedIntervalSeconds);
  if (!Number.isFinite(interval) || interval <= 0) return null;
  const seconds = Math.min(
    opts.maxStaleSeconds,
    Math.max(opts.minStaleSeconds, interval * opts.staleIntervals)
  );
  return seconds * 1000;
}

/**
 * @param {object|null} row   a `background_service_runs` row, mapped
 * @param {object} [context]
 * @param {number} [context.now]          epoch ms
 * @param {number} [context.expectedIntervalSeconds]  overrides the stored one
 * @param {number|null} [context.bootedAtMs]  when this process started, so a
 *   worker whose first pass is not due yet reads as "cannot determine" rather
 *   than "stopped" for the first few minutes after every deploy
 * @param {number} [context.firstRunDelaySeconds]
 * @returns {{state: string, reason: string, actionable: boolean,
 *   silentForMs: number|null, consecutiveFailures: number}}
 */
function classifyRun(row, context = {}) {
  const opts = { ...DEFAULTS, ...(context.options || {}) };
  const now = Number.isFinite(context.now) ? context.now : Date.now();
  const failures = Number(row?.consecutiveFailures || 0);
  const interval = Number(
    context.expectedIntervalSeconds ?? row?.expectedIntervalSeconds ?? NaN
  );

  const verdict = (state, reason, extra = {}) => ({
    state,
    reason,
    actionable: ACTIONABLE.includes(state),
    silentForMs: extra.silentForMs ?? null,
    consecutiveFailures: failures,
  });

  // A worker whose first pass is not due yet. Every deploy passes through this
  // window, and reporting it as stopped would make the state meaningless for
  // the ten minutes after every single release.
  const notDueYet = context.bootedAtMs != null
    && context.firstRunDelaySeconds != null
    && now - context.bootedAtMs < (context.firstRunDelaySeconds + 60) * 1000;

  if (!row || (!row.lastFinishedAt && !row.lastStartedAt)) {
    return verdict(RUN_STATES.UNKNOWN,
      notDueYet ? 'first pass not due yet' : 'no run has ever been recorded');
  }

  if (row.lastStatus === 'blocked') {
    return verdict(RUN_STATES.NEEDS_ATTENTION,
      row.lastError || 'waiting on configuration somebody has to supply');
  }

  const finished = toMs(row.lastFinishedAt);
  const silentFor = finished === null ? null : Math.max(0, now - finished);
  const staleAfter = staleAfterMs(interval, opts);

  // STALENESS IS CHECKED BEFORE THE STATUS, deliberately. A worker that failed
  // once and then stopped ticking reads `error` forever, and the useful fact is
  // not the error — it is that nothing has run since.
  if (staleAfter != null && silentFor != null && silentFor > staleAfter && !notDueYet) {
    return verdict(RUN_STATES.STALE,
      `no pass has finished in ${Math.round(silentFor / 60000)} minutes`,
      { silentForMs: silentFor });
  }

  if (row.lastStatus === 'error') {
    // WHAT KIND OF FAILURE, in a word that cannot contain a value.
    //
    // A critical worker reached eighteen consecutive failures in production and
    // the only thing any public surface could say was the count. The message
    // itself stays private — an `err.message` can quote a value a database
    // rejected, and this reason is published on `/api/health` — but its
    // CLASSIFICATION is safe by construction: every value comes from a fixed
    // list in `errorKind.js`. "A column is missing" and "a connection timed
    // out" are different afternoons.
    const kind = classifyErrorKind(row.lastError);
    const because = kind && kind !== 'other' ? ` — ${describeErrorKind(kind)}` : '';

    if (failures >= opts.failuresBeforeHuman) {
      return verdict(RUN_STATES.NEEDS_ATTENTION,
        `${failures} consecutive failures${because}, and it is not recovering on its own`,
        { silentForMs: silentFor, errorKind: kind });
    }
    if (failures >= opts.failuresBeforeFailing) {
      return verdict(RUN_STATES.FAILING, `${failures} consecutive failures${because}`,
        { silentForMs: silentFor, errorKind: kind });
    }
    return verdict(RUN_STATES.DEGRADED,
      (failures === 1 ? 'failed once' : `failed ${failures} times in a row`) + because,
      { silentForMs: silentFor, errorKind: kind });
  }

  // A clean pass that followed failures. `failuresTotal` moving while
  // `consecutiveFailures` is zero is what a recovery looks like from here.
  if (Number(row.failuresTotal || 0) > 0 && failures === 0) {
    const lastError = toMs(row.lastErrorAt);
    const recent = lastError !== null && now - lastError <= opts.recoveryWindowSeconds * 1000;
    if (recent) {
      return verdict(RUN_STATES.RECOVERED, 'ran clean after failing, without anybody doing anything',
        { silentForMs: silentFor });
    }
  }

  return verdict(RUN_STATES.HEALTHY,
    row.lastStatus === 'skipped' ? 'ran; nothing was due' : 'ran',
    { silentForMs: silentFor });
}

module.exports = { RUN_STATES, ACTIONABLE, DEFAULTS, staleAfterMs, classifyRun };
