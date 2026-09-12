'use strict';

/**
 * Something a person has to build, still waiting. PURE.
 *
 * WHY A REQUEST NEEDS A FINDING AT ALL. `engineering_requests` is a table, and
 * a table nobody opens is where things go to be forgotten — which is exactly
 * the failure this whole project started from: 101 undelivered alerts, retried
 * correctly, given up on correctly, and never mentioned to a human. A request
 * filed from a chat has the same shape of risk. The finding is what puts it on
 * the Needs Attention screen next to everything else that needs somebody.
 *
 * IT PROPOSES NOTHING, and there is no correction registered for it. There is
 * no automatic answer to "the software is wrong" — the resolution is a person
 * writing code, and the only thing the application can honestly do is keep
 * saying so until somebody marks the request decided. Giving this check an
 * action would mean inventing one, and an invented action here would be the
 * bot acting on a request to change itself.
 *
 * ONE FINDING PER REQUEST, keyed on its id, so ten requests read as ten items
 * rather than one growing number — each is a different thing to build.
 */

const CHECK_KEYS = ['engineering.request_open'];

/** Old enough that "nobody has looked at this" is the story. */
const STALE_DAYS = 3;

function daysSince(at, now) {
  const t = at ? new Date(at).getTime() : NaN;
  if (!Number.isFinite(t)) return null;
  return Math.floor((now.getTime() - t) / 86400000);
}

/**
 * How many open requests can be described before the picture is partial.
 * Matches the loader's ceiling; see below for why a truncated read is refused.
 */
const MAX_REQUESTS = 1000;

function runEngineeringChecks(snapshot) {
  const requests = snapshot?.engineeringRequests;
  const now = snapshot?.now instanceof Date ? snapshot.now : new Date();

  // A READ THAT FAILED IS NOT AN EMPTY LIST, AND THROWING IS HOW THAT IS SAID.
  //
  // The sweep resolves the findings of every check that RAN. Returning `[]`
  // here after a failed or truncated read would tell it every request had been
  // dealt with, and it would clear them off Needs Attention — an unavailable
  // table, or a cap, mistaken for proof that somebody did the work.
  // `consistencyService` excludes a throwing module's keys from resolution,
  // which is precisely the behaviour wanted, so this uses it rather than
  // inventing a second mechanism.
  if (!Array.isArray(requests)) {
    throw new Error('open engineering requests could not be read');
  }
  if (requests.length >= MAX_REQUESTS) {
    throw new Error(
      `${requests.length} open engineering requests is at or past the ceiling — `
      + 'the read is partial, and filing a partial picture would resolve the rest'
    );
  }

  return requests.map((r) => {
    const waiting = daysSince(r.createdAt, now);
    return {
      checkKey: 'engineering.request_open',
      subjectType: 'engineering_request',
      subjectId: String(r.id),
      title: `Something was asked for that a person has to build`
        + (waiting != null && waiting >= STALE_DAYS ? ` — waiting ${waiting} days` : ''),
      severity: waiting != null && waiting >= STALE_DAYS ? 'warning' : 'info',
      tier: 'warning',
      confidence: 100,
      evidence: {
        requestId: r.id,
        // THE WORDS, because a request whose text is hidden behind another
        // click is a request nobody reads. They are the owner's own; no id, no
        // path, no code — the schema has nowhere to put those.
        request: String(r.requestText || '').slice(0, 500),
        requestedBy: r.requestedBy || null,
        source: r.source,
        waitingDays: waiting,
        note: 'This resolves when somebody marks the request accepted, done or '
          + 'declined. Nothing in the application will act on it.',
      },
      // NOTHING IS PROPOSED, ON PURPOSE. See the header.
      proposedChange: null,
    };
  });
}

module.exports = { CHECK_KEYS, STALE_DAYS, MAX_REQUESTS, runEngineeringChecks };
