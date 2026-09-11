'use strict';

/**
 * Why a driver might be about to leave.
 *
 * Pure. Facts in, named signals and a score out. No database, no model, no
 * writes — so the thing that decides a person is "at risk" can be read, argued
 * with, and tested against a fixture, which is the least this deserves.
 *
 * THE RULE THAT SHAPES EVERY SIGNAL BELOW: a retention signal is something THE
 * COMPANY DID, or something THE DRIVER SAID. It is never an assessment of the
 * driver.
 *
 * That is not a nicety. The obvious implementation of "retention risk" is a
 * score built from how a driver behaves — how much they complain, how often
 * they are coached, how many loads they refuse — and what that produces is a
 * performance file nobody agreed to, assembled by a machine, about people who
 * cannot see it. It would also be useless: a driver leaves because they have
 * been out five weeks and their home request expired unanswered, and the
 * actionable half of that sentence is entirely the company's.
 *
 * So the signals are: promises not kept, money earned and not paid, time owed
 * and not given, and the driver's own words. Each one names something a person
 * can DO — honour the request, post the bonus, ring them — and the suggested
 * action always is that. `services/retention/watch.js` refuses to send a notice
 * that strays into an employment decision.
 *
 * ONE HARD CONSTRAINT FROM THE DATA MODEL: `chat_logs` is pruned at 30 days
 * (`services/schedulerService.js`), so every signal drawn from what a driver
 * SAID has a 30-day ceiling and a longer window would quietly read as silence.
 * The windows below respect it.
 */

/** The 30-day floor `chat_logs` retention imposes on anything message-derived. */
const MESSAGE_WINDOW_DAYS = 30;

/**
 * Weights. Deliberately blunt integers, and deliberately ordered so that the
 * things the company can fix outrank the things it can only notice.
 *
 * A driver saying they are quitting is the heaviest single signal because it is
 * the only one that is not an inference. Everything else is circumstance.
 */
const WEIGHTS = {
  quit_signal: 6,
  home_commitment_broken: 4,
  home_request_unanswered: 4,
  road_clock_over: 3,
  bonus_unpaid: 3,
  home_request_denied: 2,
  raise_not_qualified: 2,
  complaints: 2,
  gone_quiet: 2,
  sitting_empty: 2,
  negative_sentiment: 1,
};

const THRESHOLDS = {
  /** Below this, nothing is said at all. */
  notice: 4,
  /** At or above this, the notice is marked as urgent. */
  urgent: 8,
};

const DEFAULTS = {
  messageWindowDays: MESSAGE_WINDOW_DAYS,
  /** Weeks past the road allowance before it counts. One week over is normal. */
  roadOverWeeks: 1,
  /** Complaints in the window before it counts as a pattern rather than a day. */
  minComplaints: 2,
  /** Days sitting empty before it is worth mentioning. */
  emptyDays: 3,
  /** A driver's own baseline must be this chatty for silence to mean anything. */
  minBaselineMessages: 5,
};

function toTime(value) {
  const t = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
}

function daysBetween(fromIso, toMs) {
  const from = toTime(fromIso);
  if (from === null) return null;
  return Math.floor((toMs - from) / 86400000);
}

function signal(key, detail, evidence = {}) {
  return { key, weight: WEIGHTS[key] || 1, detail, evidence };
}

/**
 * One driver's signals.
 *
 * @param {object} driver everything known about them, already gathered
 * @param {object} [options]
 * @returns {{signals: Array, score: number, level: string,
 *            actions: string[], topReason: string|null}}
 */
function assess(driver, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const nowMs = toTime(options.now) ?? Date.now();
  const found = [];

  // ── What the driver said. The only signals that are not inferences. ───────

  if (driver.quitSignals > 0) {
    found.push(signal(
      'quit_signal',
      `Said something that read as leaving, ${driver.quitSignals} time${driver.quitSignals === 1 ? '' : 's'} in the last ${opts.messageWindowDays} days`,
      { count: driver.quitSignals },
    ));
  }

  if (driver.complaints >= opts.minComplaints) {
    found.push(signal(
      'complaints',
      `${driver.complaints} messages read as complaints in the last ${opts.messageWindowDays} days`,
      { count: driver.complaints },
    ));
  }

  // A number, not a judgement: the annotator's own -2..+2 scale, averaged.
  if (typeof driver.avgSentiment === 'number' && driver.avgSentiment <= -0.5) {
    found.push(signal(
      'negative_sentiment',
      `Their messages have been mostly negative (${driver.avgSentiment.toFixed(1)} on a -2 to +2 scale)`,
      { avgSentiment: driver.avgSentiment },
    ));
  }

  // Silence measured against the DRIVER'S OWN baseline, never an absolute. A
  // driver who has never texted much is not a risk; one who used to and has
  // stopped is a different fact entirely.
  if (driver.baselineMessages >= opts.minBaselineMessages && driver.recentMessages === 0) {
    found.push(signal(
      'gone_quiet',
      `Used to write ${driver.baselineMessages} messages a month and has written none recently`,
      { baseline: driver.baselineMessages, recent: driver.recentMessages },
    ));
  }

  // ── What the company did, or did not do. ─────────────────────────────────

  const weeksOver = Number(driver.roadWeeksOverAllowance || 0);
  if (weeksOver >= opts.roadOverWeeks) {
    found.push(signal(
      'road_clock_over',
      `${weeksOver} week${weeksOver === 1 ? '' : 's'} past the road allowance`,
      { weeksOver, daysOnRoad: driver.daysOnRoad ?? null },
    ));
  }

  if (driver.brokenHomeCommitments > 0) {
    found.push(signal(
      'home_commitment_broken',
      `A home window was agreed and not honoured (${driver.brokenHomeCommitments} time${driver.brokenHomeCommitments === 1 ? '' : 's'})`,
      { count: driver.brokenHomeCommitments },
    ));
  }

  if (driver.unansweredHomeRequests > 0) {
    found.push(signal(
      'home_request_unanswered',
      `${driver.unansweredHomeRequests} home time request${driver.unansweredHomeRequests === 1 ? '' : 's'} expired without an answer`,
      { count: driver.unansweredHomeRequests },
    ));
  }

  if (driver.deniedHomeRequests > 0) {
    found.push(signal(
      'home_request_denied',
      `${driver.deniedHomeRequests} home time request${driver.deniedHomeRequests === 1 ? '' : 's'} were declined`,
      { count: driver.deniedHomeRequests },
    ));
  }

  const owed = Number(driver.unpaidBonusUsd || 0);
  if (owed > 0 || driver.unpaidBonusCount > 0) {
    found.push(signal(
      'bonus_unpaid',
      owed > 0
        ? `$${owed} of earned bonus has not been paid or posted`
        : `${driver.unpaidBonusCount} earned bonuses have not been paid or posted`,
      { usd: owed, count: driver.unpaidBonusCount || 0 },
    ));
  }

  if (driver.raiseNotQualifiedRounds > 0) {
    found.push(signal(
      'raise_not_qualified',
      `Not selected in ${driver.raiseNotQualifiedRounds} raise round${driver.raiseNotQualifiedRounds === 1 ? '' : 's'}`,
      { rounds: driver.raiseNotQualifiedRounds },
    ));
  }

  const emptyDays = driver.emptySince ? daysBetween(driver.emptySince, nowMs) : null;
  if (emptyDays !== null && emptyDays >= opts.emptyDays) {
    found.push(signal(
      'sitting_empty',
      `Sitting empty for ${emptyDays} days`,
      { days: emptyDays, since: driver.emptySince },
    ));
  }

  const score = found.reduce((n, s) => n + s.weight, 0);
  const ordered = [...found].sort((a, b) => b.weight - a.weight);

  return {
    signals: ordered,
    score,
    level: score >= THRESHOLDS.urgent ? 'urgent' : (score >= THRESHOLDS.notice ? 'watch' : 'none'),
    actions: suggestActions(ordered),
    topReason: ordered[0]?.detail || null,
  };
}

/**
 * What somebody could actually DO — which is the whole point of the feature.
 *
 * Every suggestion is a company action. There is deliberately no branch that
 * produces "review this driver", "consider replacement", or anything else about
 * their employment: this module has no vocabulary for it, and the watcher
 * refuses a notice containing that language even so.
 *
 * Capped at three. A list of eight things to do is a list nobody starts.
 */
function suggestActions(signals) {
  const by = new Set(signals.map((s) => s.key));
  const actions = [];

  if (by.has('quit_signal')) actions.push('Ring them today — they have said something about leaving');
  if (by.has('home_commitment_broken') || by.has('home_request_unanswered')) {
    actions.push('Answer their home time request and give them a date they can hold you to');
  }
  if (by.has('road_clock_over') && !by.has('home_commitment_broken')) {
    actions.push('Get them home — they are past the allowance');
  }
  if (by.has('bonus_unpaid')) actions.push('Check why the earned bonus has not been paid');
  if (by.has('sitting_empty')) actions.push('Find them a load — they have been sitting');
  if (by.has('complaints') || by.has('negative_sentiment')) {
    actions.push('Read their recent messages and answer what they raised');
  }
  if (by.has('gone_quiet') && actions.length === 0) actions.push('Check in with them — they have gone quiet');
  if (by.has('raise_not_qualified') && actions.length < 3) {
    actions.push('Tell them what they would need for the next raise round');
  }

  return actions.slice(0, 3);
}

/** Everyone worth saying something about, most at risk first. */
function assessAll(drivers, options = {}) {
  return (drivers || [])
    .map((d) => ({ driver: d, ...assess(d, options) }))
    .filter((a) => a.level !== 'none')
    .sort((a, b) => b.score - a.score);
}

module.exports = {
  MESSAGE_WINDOW_DAYS,
  WEIGHTS,
  THRESHOLDS,
  DEFAULTS,
  assess,
  assessAll,
  suggestActions,
};
