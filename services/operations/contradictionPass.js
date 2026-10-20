'use strict';

/**
 * When two features disagree about one driver, ask a person.
 *
 * WHAT WAS MISSING. `lib/drivers/context.js` and `database/driverContext.js`
 * were written, tested and required by NOTHING — `database/driverContext.js`
 * not even by a test file. Each feature went on reading its own table and
 * reaching its own verdict about the same human, and the contradiction lived
 * only in the head of whoever happened to read two screens. This is the caller
 * that was missing.
 *
 * THE RULE IT WILL NOT BREAK: A CONTRADICTION IS REPORTED, NEVER RESOLVED.
 * When Home Time says a driver is at home and the load board has their truck in
 * transit, the answer is not the more recent row, the more confident feature,
 * or the one with more evidence. It is that a person must look. So every
 * finding here is filed at tier `warning` — the tier that has no apply action
 * at all — and nothing in this file writes to any feature's own table.
 *
 * AND THE MOST VALUABLE ONE IS NOT ABOUT A DRIVER. `quiet_but_active` fires
 * when retention has somebody as gone quiet while the fleet shows them driving
 * this morning. That is not a retention signal; it is a feed that stopped
 * reporting. Telling those two apart is the whole reason for holding one
 * picture of a driver in one place, and a retention notice about somebody who
 * drove 400 miles yesterday is the exact mistake it prevents.
 *
 * COVERAGE TRAVELS WITH EVERY FINDING. Three sections unreadable and no
 * contradictions found is not a clean bill of health, it is a mostly blank
 * page, and a reader cannot tell those apart from the finding alone.
 */
const { findContradictions, coverage } = require('../../lib/drivers/context');

/** Which contradictions are worth interrupting somebody about. */
const SEVERITY = Object.freeze({
  home_while_working: 'warning',
  quiet_but_active: 'warning',
  two_open_units: 'serious',
});

/**
 * How many drivers one pass will read in full.
 *
 * The screen is one query over the fleet; this caps what it can cost when the
 * screen is unexpectedly generous — a retention run that marked half the fleet
 * quiet, say. Hitting the cap is itself worth saying, so the summary reports it
 * rather than silently truncating.
 */
const MAX_PER_PASS = 40;

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    context: require('../../database/driverContext'),
    findings: require('../../database/operationalFindings'),
    notify: require('../notifications/send').notify,
  };
  /* eslint-enable global-require */
}

/** `check_key` is per KIND, so one driver with two problems files two rows. */
function checkKeyFor(kind) {
  return `context.${kind}`;
}

/**
 * Every check key this pass owns, which is the scope resolution may clear.
 *
 * Derived from SEVERITY so a new contradiction kind cannot be filed under a key
 * this pass then refuses to resolve — the two would drift the moment somebody
 * added a kind in one place only.
 */
const CHECK_KEYS = Object.freeze(
  Object.fromEntries(Object.keys(SEVERITY).map((kind) => [kind, checkKeyFor(kind)]))
);

/**
 * One driver. Returns the kinds actually filed.
 *
 * A read that fails costs this driver and nothing else: the pass over the rest
 * of the fleet must not end because one person's rows were unreadable.
 */
async function checkOneDriver(personId, { deps, now }) {
  const context = await deps.context.getDriverContext(personId);
  const found = findContradictions(context, { now });
  if (!found.length) return [];

  const seen = coverage(context);
  const filed = [];

  for (const contradiction of found) {
    const title = `${context.identity?.displayName || `Driver ${personId}`}: `
      + 'two systems disagree';
    // eslint-disable-next-line no-await-in-loop
    const row = await deps.findings.upsertFinding({
      checkKey: checkKeyFor(contradiction.kind),
      subjectType: 'person',
      subjectId: personId,
      title,
      severity: SEVERITY[contradiction.kind] || 'warning',
      // NEVER `auto`. There is no correct automatic answer to two features
      // disagreeing about a human, and a tier that allowed one would be the
      // single most dangerous setting in this application.
      tier: 'warning',
      evidence: {
        kind: contradiction.kind,
        summary: contradiction.summary,
        sides: contradiction.sides,
        ...contradiction.evidence,
        coverage: seen,
      },
      proposedChange: null,
      confidence: null,
    });

    // eslint-disable-next-line no-await-in-loop
    await deps.notify({
      category: 'needs_attention',
      title,
      lines: [
        contradiction.summary,
        seen.missing.length
          ? `Read ${seen.known} of ${seen.total} sources; nothing to say about `
            + `${seen.missing.join(', ')}`
          : null,
      ].filter(Boolean),
      action: 'Look at the driver and decide which is right — Wenze will not pick a side',
      subjectType: 'person',
      subjectId: personId,
      personId,
      severity: SEVERITY[contradiction.kind] || 'warning',
      // NO FACTS. Nothing here is a distance or a deadline, so there is nothing
      // for the urgency rules to escalate on, and inventing one to make a
      // contradiction look urgent would be exactly the fabrication the
      // priority module refuses.
      discriminator: contradiction.kind,
      evidence: { kind: contradiction.kind, sides: contradiction.sides },
    });
    filed.push({ kind: contradiction.kind, id: row?.id || null });
  }
  return filed;
}

/**
 * One pass. Never throws.
 *
 * @returns {Promise<{candidates:number, read:number, filed:number,
 *   capped:boolean, errors:string[]}>}
 */
async function runContradictionPass({
  now = new Date().toISOString(), deps = defaultDeps(), limit = MAX_PER_PASS,
} = {}) {
  const summary = {
    candidates: 0, read: 0, filed: 0, resolved: 0, capped: false, errors: [],
  };
  // THE LEDGER READS `summary.error`, SINGULAR. `errors` is the per-driver
  // list a reader wants; `statusFromSummary` knows nothing about it, so a pass
  // that failed entirely was recorded as `ok` — which defeats the Operations
  // entry this pass was registered for in the first place. Set below.


  let candidates;
  try {
    candidates = await deps.context.listContradictionCandidates({ limit: limit + 1 });
  } catch (err) {
    // The screen failing is the whole pass failing, and it is reported as such
    // rather than as a clean run that found nothing — which is the ambiguity
    // this project exists to remove.
    summary.errors.push(`screen: ${err.message}`);
    // The screen failing IS the pass failing — there is nothing else it does.
    summary.error = `the candidate screen could not be read: ${err.message}`;
    return summary;
  }

  summary.candidates = candidates.length;
  if (candidates.length > limit) {
    summary.capped = true;
    candidates = candidates.slice(0, limit);
  }

  const keepIds = [];
  for (const personId of candidates) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const filed = await checkOneDriver(personId, { deps, now });
      summary.read += 1;
      summary.filed += filed.length;
      keepIds.push(...filed.map((f) => f.id).filter(Boolean));
    } catch (err) {
      summary.errors.push(`person ${personId}: ${err.message}`);
    }
  }

  // A CONTRADICTION THAT CLEARED MUST STOP SAYING TWO SYSTEMS DISAGREE.
  //
  // Nothing here resolved anything, so a finding stayed open for ever after the
  // condition went away — telling operators about a disagreement that no longer
  // exists, which is how a Needs Attention list stops being read.
  //
  // ONLY WHEN THE PASS ACTUALLY RAN, and never after a partial one. The sweep's
  // own rule: a screen that failed, a capped pass, or any driver that could not
  // be read means some contradictions were not re-derived this time, and
  // resolving on that basis would close findings that are still true.
  const complete = !summary.error && !summary.capped && summary.errors.length === 0;
  if (complete) {
    try {
      // Optional-chained: a dependency map without the resolve costs the
      // RESOLUTION, not the pass — the same rule the rest of this work follows.
      summary.resolved = await Promise.resolve(
        deps.findings.resolveClearedFindings?.(Object.values(CHECK_KEYS), keepIds)
      ) || 0;
    } catch (err) {
      summary.errors.push(`resolve: ${err.message}`);
    }
  }

  // EVERY DRIVER FAILING IS ALSO A FAILED PASS. One unreadable driver is
  // noise; a pass that read nobody it was asked to read has not run, whatever
  // its counters say.
  if (!summary.read && summary.candidates > 0) {
    summary.error = `none of the ${summary.candidates} candidate(s) could be read`;
  }

  if (summary.filed || summary.capped || summary.error) {
    console.log(`[CONTRADICTION] ${summary.candidates} candidate(s), `
      + `${summary.filed} disagreement(s) filed`
      + `${summary.capped ? ` — capped at ${limit}, more remain` : ''}`);
  }
  return summary;
}

module.exports = {
  SEVERITY,
  CHECK_KEYS,
  MAX_PER_PASS,
  checkKeyFor,
  checkOneDriver,
  runContradictionPass,
  defaultDeps,
};
