'use strict';

/**
 * Deciding when a subsystem's health is worth telling somebody about.
 *
 * Pure. Previous state plus one observation in, next state and at most one
 * announcement out. No database, no clock of its own.
 *
 * THIS IS NOT A RECOVERY MECHANISM. Wenze already recovers from most of its own
 * integration failures and always has: RingCentral refresh tokens are rotated
 * daily and at boot, an AI provider in cooldown returns on its own timer, a
 * retired model is dropped and the next promoted, the durable outboxes back off
 * and retry. Every one of those recoveries is SILENT, so "Wenze fixed itself"
 * and "Wenze has been broken for three days" look identical from outside — and
 * the second one is the reason the first is worth saying out loud.
 *
 * What was missing is the noticing. This module is the noticing, and its whole
 * difficulty is saying it rarely enough to be read.
 *
 * FOUR RULES, AND THE THIRD IS THE ONE THAT MATTERS.
 *
 * 1. A single failure says nothing. Integrations blip; a provider 503s and the
 *    next call succeeds. Nothing is announced until `failuresBeforeAlert`
 *    consecutive failures, so an outage has to be real before anybody hears.
 *
 * 2. Recovery is announced only to people who were told about the failure.
 *    **If Wenze never said it broke, it does not say it healed.** A blip that
 *    self-corrects inside the threshold produces ZERO messages, not one. Get
 *    this backwards and the "Wenze fixed itself" channel fills with recoveries
 *    from failures nobody knew about, which is the fastest way to make a
 *    channel unread.
 *
 * 3. A component that breaks and heals repeatedly is ONE problem, not six
 *    messages. Past `flapThreshold` transitions inside `flapWindowHours` it is
 *    announced once as flapping and then goes quiet — the recoveries are real
 *    but they are not news, and something that cannot stay up needs a person
 *    rather than a commentary.
 *
 * 4. Nothing is announced twice. `announcedStatus` is the record of what the
 *    people reading were last told, which is a different thing from what is
 *    true now, and it is what every suppression above is decided against.
 */

const DEFAULTS = {
  failuresBeforeAlert: 3,
  flapWindowHours: 6,
  flapThreshold: 4,
  /** How many transitions to remember. Enough for the flap window, no more. */
  keepTransitions: 12,
};

const OK = 'ok';
const FAILED = 'failed';

/** A component nobody has observed yet. */
function initialState(component) {
  return {
    component,
    status: null,
    since: null,
    consecutiveFailures: 0,
    consecutiveOk: 0,
    announcedStatus: null,
    lastError: null,
    transitions: [],
    flappingSince: null,
  };
}

function toTime(value) {
  const t = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
}

/** Transitions inside the window, newest kept. */
function recentTransitions(transitions, nowMs, windowHours) {
  const cutoff = nowMs - windowHours * 3600 * 1000;
  return (transitions || []).filter((t) => {
    const at = toTime(t?.at);
    return at !== null && at >= cutoff;
  });
}

/**
 * @param {object|null} previous  the stored state, or null for a first sighting
 * @param {{ok: boolean, detail?: string|null}} observation
 * @param {object} [options]
 * @returns {{state: object, announce: null|{kind: string, component: string,
 *           detail: string|null, downForMs: number|null, transitions: number}}}
 */
function observe(previous, observation, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const nowIso = options.now || new Date().toISOString();
  const nowMs = toTime(nowIso) ?? Date.now();

  const component = previous?.component || observation?.component || 'unknown';
  const prev = previous || initialState(component);
  const ok = observation?.ok === true;
  const detail = observation?.detail ? String(observation.detail).slice(0, 300) : null;

  const status = ok ? OK : FAILED;
  const changed = prev.status !== null && prev.status !== status;

  const transitions = changed
    ? [...(prev.transitions || []), { at: nowIso, to: status }].slice(-opts.keepTransitions)
    : (prev.transitions || []);

  const state = {
    component,
    status,
    since: changed || prev.since === null ? nowIso : prev.since,
    consecutiveFailures: ok ? 0 : (prev.consecutiveFailures || 0) + 1,
    consecutiveOk: ok ? (prev.consecutiveOk || 0) + 1 : 0,
    announcedStatus: prev.announcedStatus || null,
    // The last error is kept while the component is down and cleared when it
    // comes back, so a stale message cannot be attached to a healthy component.
    lastError: ok ? null : (detail || prev.lastError || null),
    transitions,
    flappingSince: prev.flappingSince || null,
  };

  const recent = recentTransitions(transitions, nowMs, opts.flapWindowHours);

  // Rule 3, checked before either of the others: a component that cannot stay
  // in one state is one problem. Announced once, then silent while it lasts.
  if (recent.length >= opts.flapThreshold) {
    if (!prev.flappingSince) {
      state.flappingSince = nowIso;
      state.announcedStatus = 'flapping';
      return {
        state,
        announce: {
          kind: 'flapping',
          component,
          detail: state.lastError,
          downForMs: null,
          transitions: recent.length,
        },
      };
    }
    // Already said. Nothing more until it settles.
    return { state, announce: null };
  }

  // Settled: the window has emptied, so the next real change may speak again.
  if (prev.flappingSince && recent.length < opts.flapThreshold) {
    state.flappingSince = null;
  }

  // Rule 1 — a real outage, announced once.
  if (!ok
    && state.consecutiveFailures >= opts.failuresBeforeAlert
    && state.announcedStatus !== FAILED) {
    state.announcedStatus = FAILED;
    return {
      state,
      announce: {
        kind: 'broke', component, detail: state.lastError, downForMs: null, transitions: recent.length,
      },
    };
  }

  // Rule 2 — recovery, and ONLY to people who heard about the failure.
  if (ok && state.announcedStatus === FAILED) {
    state.announcedStatus = OK;
    const brokeAt = toTime(prev.since);
    return {
      state,
      announce: {
        kind: 'healed',
        component,
        detail: prev.lastError || null,
        downForMs: brokeAt === null ? null : Math.max(0, nowMs - brokeAt),
        transitions: recent.length,
      },
    };
  }

  // A recovery from a blip nobody was told about. Deliberately silent.
  if (ok && state.announcedStatus === null) state.announcedStatus = null;

  return { state, announce: null };
}

/** "3 hours", "2 days", "under a minute" — for a sentence, not a log line. */
function describeDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null;
  // The sub-minute test is on the milliseconds, not on the rounded minutes:
  // Math.round(30000 / 60000) is 1, so rounding first reports half a minute of
  // downtime as a whole one. Small, and exactly the kind of thing that makes a
  // reader stop trusting the other numbers in the same sentence.
  if (ms < 60000) return 'under a minute';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

module.exports = {
  DEFAULTS,
  OK,
  FAILED,
  initialState,
  recentTransitions,
  observe,
  describeDuration,
};
