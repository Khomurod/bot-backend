/**
 * The two observations that ask "did it ARRIVE", not "did the pass run".
 *
 * The rules are pure and live in lib/operations/deliveryTruth.js; this file
 * only reads the rows they judge. Both answer `cannot_determine` — never
 * healthy — when the rows cannot be read.
 */
const { RUN_STATES } = require('../../../lib/operations/runHealth');
const {
  reconcileSafetyCounts, safetyLossNeedsAPerson, assessNoticeOutbox, publicTelegramError,
} = require('../../../lib/operations/deliveryTruth');
const { integration } = require('./shape');

/**
 * Safety events the poller saw and the store did not keep.
 *
 * Returns null when there is nothing to say — the counts agree, or the poller
 * reports no total, or it saw nothing — so the caller keeps its run verdict.
 * Returns `{ unknown }` when events WERE seen and the stored rows cannot be
 * counted: a missing table or a permission fault stops recording and counting
 * at once, and falling back to "the poller ran" would call that healthy.
 * Returns the failure when events are being lost — that outranks a clean run.
 */
async function safetyEventsLost(deps, pollerRow) {
  const summary = pollerRow?.lastSummary || {};
  const seen = Number.isFinite(Number(summary.eventsSeenTotal)) ? Number(summary.eventsSeenTotal) : null;
  const since = summary.seenSince || null;
  if (seen == null || !since || seen === 0) return null;
  const recorded = await Promise.resolve(deps.safety?.countRecordedSince?.(since)).catch(() => null);
  if (recorded == null) {
    return {
      unknown: true,
      reason: `the poller picked up ${seen} event(s) since it booted and the stored rows could not be counted`,
    };
  }
  const verdict = reconcileSafetyCounts(seen, recorded);
  if (verdict.state !== 'events_lost' || !safetyLossNeedsAPerson(seen, recorded)) return null;
  const refused = Number(summary.recordingRefused);
  const why = Number.isFinite(refused) && refused > 0
    ? ` The poller's store refused ${refused} of them for a missing field.`
    : '';
  return { reason: `${verdict.reason}.${why}` };
}

/** Are the three managers being told? */
async function managerNoticeObservation(deps) {
  try {
    const byEvent = await deps.homeTimeObservability.summariseManagerNotices();
    const verdict = assessNoticeOutbox(byEvent);
    if (!verdict.known) {
      return integration('home_time_manager_notices', { ok: true, state: RUN_STATES.UNKNOWN, reason: verdict.reason });
    }
    if (verdict.ok) return integration('home_time_manager_notices', { ok: true, reason: verdict.reason });
    const last = await Promise.resolve(deps.homeTime?.latestNoticeFailure?.()).catch(() => null);
    const said = publicTelegramError(last?.lastError);
    const reason = said ? `${verdict.reason}. Telegram said: "${said}"` : verdict.reason;
    return integration('home_time_manager_notices', {
      ok: false, state: RUN_STATES.NEEDS_ATTENTION, detail: reason, reason,
    });
  } catch (_) {
    return integration('home_time_manager_notices', { ok: true, state: RUN_STATES.UNKNOWN, reason: 'could not read' });
  }
}

module.exports = { safetyEventsLost, managerNoticeObservation };
