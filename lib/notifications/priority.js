'use strict';

/**
 * How much a notice deserves somebody's attention right now, and when it should
 * not be sent at all.
 *
 * A CATEGORY'S SEVERITY IS A CONSTANT, AND URGENCY IS NOT. `fuel` is a
 * `warning` whether the truck is twenty miles from a station with half a tank
 * or four hundred miles out at eight percent. Sending both as the same thing
 * teaches people that the word means nothing, and the second one is the one
 * that costs money.
 *
 * THREE LEVELS, defined by what happens if nobody looks:
 *
 *   now       it gets worse by the hour
 *   today     it needs a person today
 *   whenever  a record; read it when convenient
 *
 * WHAT MAY MOVE IT. Only facts already established elsewhere — a distance, a
 * percentage, a date, a count. Nothing here reads a model's opinion, and
 * nothing here invents a fact to justify a level. A test asserts the function
 * has no parameter through which a model could raise an alarm, for the same
 * reason the decision engine does.
 *
 * AND THE OWNER'S FLOOR IS A CEILING TOO. A category the owner marked `info`
 * cannot be escalated to `now` by circumstance. If they have said this kind of
 * thing is never urgent, circumstance does not get a vote — it was their
 * decision about their business, and overriding it is how a notification system
 * becomes one people mute.
 */

const LEVELS = Object.freeze({ NOW: 'now', TODAY: 'today', WHENEVER: 'whenever' });
const ORDER = Object.freeze([LEVELS.WHENEVER, LEVELS.TODAY, LEVELS.NOW]);

/** What a category's stated severity allows at most. */
const CEILING = Object.freeze({
  info: LEVELS.WHENEVER,
  warning: LEVELS.TODAY,
  serious: LEVELS.NOW,
});

function atMost(level, ceiling) {
  return ORDER.indexOf(level) <= ORDER.indexOf(ceiling) ? level : ceiling;
}

/**
 * @param {object} input
 * @param {string} input.severity  the category's stated severity
 * @param {object} [input.facts]   established numbers, never opinions
 * @returns {{level:string, reasons:string[], ceiling:string}}
 */
function priorityFor({ severity = 'info', facts = {} } = {}) {
  const ceiling = CEILING[severity] || LEVELS.WHENEVER;
  const reasons = [];
  let level = LEVELS.WHENEVER;

  // Fuel: how far it can go against how far it must.
  if (Number.isFinite(facts.rangeMiles) && Number.isFinite(facts.milesToStation)) {
    const spare = facts.rangeMiles - facts.milesToStation;
    if (spare <= 0) {
      level = LEVELS.NOW;
      reasons.push(`it cannot reach the next stop — ${Math.round(facts.milesToStation)} miles `
        + `to go and about ${Math.round(facts.rangeMiles)} in the tank`);
    } else if (spare < 50) {
      level = LEVELS.TODAY;
      reasons.push(`only about ${Math.round(spare)} miles of margin to the next stop`);
    }
  }

  // A deadline already past is a different thing from one approaching.
  if (Number.isFinite(facts.hoursUntilDue)) {
    if (facts.hoursUntilDue < 0) {
      level = LEVELS.NOW;
      reasons.push(`it was due ${Math.abs(Math.round(facts.hoursUntilDue))} hours ago`);
    } else if (facts.hoursUntilDue <= 12) {
      level = raise(level, LEVELS.TODAY);
      reasons.push(`due in ${Math.round(facts.hoursUntilDue)} hours`);
    }
  }

  // How many people it is about. One driver is a conversation; thirty is an
  // outage somewhere.
  if (Number.isFinite(facts.driversAffected) && facts.driversAffected >= 10) {
    level = raise(level, LEVELS.TODAY);
    reasons.push(`${facts.driversAffected} drivers are affected, which usually means `
      + 'something upstream rather than thirty separate problems');
  }

  const capped = atMost(level, ceiling);
  if (capped !== level) {
    reasons.push(`held at "${ceiling}" because this category is marked ${severity}`);
  }
  return { level: capped, reasons, ceiling };
}

function raise(current, to) {
  return ORDER.indexOf(to) > ORDER.indexOf(current) ? to : current;
}

/**
 * Has this person already been told enough about this driver today?
 *
 * THE FAILURE THIS PREVENTS is not duplication — the notice key already handles
 * that. It is the DIFFERENT notices about the SAME driver arriving within
 * minutes of each other: a fuel risk, a load contradiction and a retention
 * signal about one person, each correctly deduplicated against itself, together
 * reading as three problems when they are one driver having one bad morning.
 *
 * A `now` is never suppressed. Whatever else somebody has been told, a thing
 * that gets worse by the hour is worth the interruption.
 */
function shouldSuppress({
  level = LEVELS.WHENEVER, subjectKey = null, recent = [], windowMinutes = 60, maxPerSubject = 3,
} = {}) {
  if (level === LEVELS.NOW) return { suppress: false, why: 'a "now" is always worth saying' };
  if (!subjectKey) return { suppress: false, why: 'nothing to group by' };

  const cutoff = Date.now() - windowMinutes * 60000;
  const about = (recent || []).filter((n) => {
    if (!n || n.subjectKey !== subjectKey) return false;
    const at = Date.parse(n.at || '');
    return Number.isFinite(at) && at >= cutoff;
  });

  if (about.length < maxPerSubject) {
    return { suppress: false, why: `${about.length} notice(s) about this subject in the window` };
  }
  return {
    suppress: true,
    why: `${about.length} notices about this subject already in the last `
      + `${windowMinutes} minutes — one driver having one bad morning reads as `
      + 'three problems otherwise',
  };
}

module.exports = { LEVELS, ORDER, CEILING, priorityFor, shouldSuppress };
