'use strict';

/**
 * Rebuilding the dispatch roster from the Dispatcher Board, immediately before
 * the weekly Driver Raise round goes out.
 *
 * WHAT THIS REPLACES. A dispatch team's driver list used to be typed by hand
 * and then quietly aged: a driver moved to another dispatcher in March and the
 * roster still said otherwise in July, so the wrong dispatcher reviewed their
 * rate. The Board already knows who dispatches whom — it is the column
 * dispatch keeps current because they work from it — so the roster is rebuilt
 * from it rather than remembered.
 *
 * THE ORDER IS THE POINT. Reconciliation runs BEFORE the round is opened, in
 * the same tick, and a round is not opened if it could not run. A review form
 * built from last week's roster is worse than a late one, because nothing about
 * it looks wrong.
 *
 * IT NEVER GUESSES, IN EITHER DIRECTION.
 *
 *   Which PERSON a board row is about is decided by the same pure rule the
 *   board-link check uses (lib/identity/boardResolution.js): the truck and the
 *   name must agree, and a digits-only truck match may not act. Reusing it is
 *   deliberate — a second matcher with slightly different rules is how two
 *   parts of one system start disagreeing about who somebody is.
 *
 *   Which TEAM a dispatcher belongs to is decided by lib/raise/dispatcherTeam.js:
 *   forgiving about spelling, exact about identity.
 *
 * Anything either rule cannot settle becomes a finding a person reads, and the
 * driver is left off a roster rather than put on a plausible one.
 *
 * STALE BOARD ⇒ NO ROUND. If the Board has not been read recently enough to
 * trust, this refuses rather than rebuilding the roster from a snapshot that
 * may predate the moves it is supposed to capture.
 */

const { matchDispatcherToTeam } = require('../../lib/raise/dispatcherTeam');
const { planRoster, personKeyOf, OUTCOME, REVIEW_REASON } = require('../../lib/raise/rosterPlan');
const { loadPersonLayer, resolveBoardRowsToPeople } = require('../dispatchBoard/rowPeople');
const { serviceError } = require('./errors');
const { normalizeDriverName } = require('../mileageBonusConstants');

const CHECK_UNPLACED = 'raise.driver_unplaced';

/**
 * The roster could not be rebuilt at all, so no round was opened.
 *
 * A REFUSAL HAS TO BE LOUDER THAN A LOG LINE. The whole reason the round stops
 * is that nobody would notice a wrong one; a refusal nobody notices either is
 * the same failure with a different shape — the review simply never arrives and
 * the week passes. This is the finding that puts it on a person's screen.
 */
const CHECK_ROSTER_BLOCKED = 'raise.roster_not_rebuilt';

/**
 * How old the Board's last successful read may be and still be worth rebuilding
 * a roster from.
 *
 * The poller runs every few minutes, so six hours is not a tight deadline — it
 * is the line past which "the Board is live" stops being true. A Sunday round
 * built on a Friday snapshot would place drivers by where they were, not where
 * they are.
 */
const MAX_BOARD_AGE_HOURS = 6;

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    board: require('../../database/dispatchBoard'),
    boardSettings: require('../../database/dispatchBoardSettings'),
    ra: require('../../database/raiseApproval'),
    directory: require('../driverGroupDirectoryService'),
    findings: require('../../database/operationalFindings'),
    db: require('../../database/db'),
  };
  /* eslint-enable global-require */
}

/** Teams as the matcher wants them: a name and the dispatchers on it. */
async function loadTeams(deps) {
  const teams = await deps.ra.listDispatchTeams({ includeInactive: false });
  const out = [];
  for (const team of teams) {
    // eslint-disable-next-line no-await-in-loop
    const members = await deps.ra.listTeamMembers(team.id, { activeOnly: true });
    out.push({
      id: team.id,
      name: team.name,
      memberNames: members.map((m) => m.name).filter(Boolean),
    });
  }
  return out;
}

/** The person layer, in the shape the shared board resolver reads. */
async function loadLayer(deps) {
  return loadPersonLayer(deps.db);
}

/**
 * Board rows keyed by the driver they are about.
 *
 * Delegated to services/dispatchBoard/rowPeople.js so the roster and the
 * home-time watch cannot drift into disagreeing about who a row names.
 */
function boardRowsByDriver(rows, layer) {
  const { byPerson, unresolved } = resolveBoardRowsToPeople(rows, layer);
  const byDriver = new Map();
  for (const [key, entry] of byPerson.entries()) {
    byDriver.set(key, entry.duplicate
      ? { duplicate: true, rowKey: entry.rowKey, dispatcher: null, match: null }
      : { rowKey: entry.rowKey, dispatcher: entry.dispatcher, personId: entry.personId, match: null });
  }
  return { byDriver, unresolved };
}

/** Drivers a raise review covers: active company drivers, by person where known. */
async function loadEligibleDrivers(deps) {
  const rows = await deps.directory.listCanonicalDriverGroups({ operational: true });
  const out = [];
  for (const row of rows) {
    if (row.group_type !== 'driver') continue;
    if (row.driver_type !== 'company_driver') continue;
    if (row.inactive) continue;
    out.push({
      personId: row.person_id || null,
      driverProfileId: row.profile_id || null,
      groupId: row.group_id || null,
      unitNumber: row.unit_number || null,
      driverName: row.display_name || row.primary_display_name || row.group_name || '',
      // THE SAME KEY THE PICKS TABLE USES. `raise_round_picks` and the public
      // review form are both keyed on `normalizeDriverName`, so a roster built
      // on any other spelling would place drivers the form could not find.
      driverNormalizedName: normalizeDriverName(
        row.primary_display_name || row.display_name || row.group_name || ''
      ) || null,
    });
  }
  return out;
}

function reviewTitle(reason, who) {
  switch (reason) {
    case REVIEW_REASON.NO_DISPATCHER:
      return `The board has no dispatcher for ${who}`;
    case REVIEW_REASON.AMBIGUOUS_DISPATCHER:
      return `More than one dispatch team answers to ${who}'s dispatcher`;
    case REVIEW_REASON.NO_BOARD_ROW:
      return `${who} is not on the dispatcher board`;
    case REVIEW_REASON.UNRESOLVED_IDENTITY:
      return `${who} has no stable identity to place`;
    default:
      return `No dispatch team is named after ${who}'s dispatcher`;
  }
}

/**
 * Is the Board fresh enough to rebuild a roster from?
 *
 * Three different answers, and they are not the same problem: switched off,
 * never read, and read too long ago. Each one is reported as itself so the
 * operator is told what to fix rather than that "something is wrong".
 */
function boardFreshness(settings, now = Date.now()) {
  if (!settings || !settings.enabled) {
    return { ok: false, reason: 'the Dispatcher Board is switched off in Settings' };
  }
  if (!settings.lastPollAt) {
    return { ok: false, reason: 'the Dispatcher Board has never been read' };
  }
  if (settings.lastPollOk === false) {
    return { ok: false, reason: 'the last Dispatcher Board read failed' };
  }
  const ageMs = now - new Date(settings.lastPollAt).getTime();
  const maxMs = MAX_BOARD_AGE_HOURS * 3600 * 1000;
  if (!Number.isFinite(ageMs) || ageMs > maxMs) {
    const hours = Number.isFinite(ageMs) ? Math.round(ageMs / 3600000) : null;
    return {
      ok: false,
      reason: hours == null
        ? 'the Dispatcher Board read time cannot be read'
        : `the Dispatcher Board was last read ${hours}h ago, more than the ${MAX_BOARD_AGE_HOURS}h a roster may be built on`,
    };
  }
  return { ok: true, ageMs };
}

/** File the "no round could be built" problem where a person will read it. */
async function blocked(deps, reason) {
  await deps.findings.upsertFinding({
    checkKey: CHECK_ROSTER_BLOCKED,
    subjectType: 'raise_round',
    subjectId: 'weekly',
    title: 'The weekly driver-raise review could not be sent',
    severity: 'serious',
    tier: 'warning',
    evidence: { reason, consequence: 'no review round was opened, so no dispatcher was asked' },
    proposedChange: null,
  }).catch(() => {});
}

/**
 * Rebuild every dispatch team's roster from the current Board.
 *
 * IDEMPOTENT. Running it twice changes nothing the second time: a driver
 * already on the right team is a `keep`, the finding upsert is keyed by
 * `(check_key, subject)`, and the assignment write is a transaction guarded on
 * the row it read. That matters because it runs on a schedule AND from the
 * admin's Send now, and the two can land together.
 *
 * REFUSES RATHER THAN GUESSES. A Board that is off, unread or stale throws —
 * the caller does not open a round on it — because a roster rebuilt from an
 * old snapshot is confidently wrong in exactly the way nobody checks.
 *
 * @returns `{ ok, summary, reviews, teams, boardAgeMs }`
 */
async function reconcileRosterFromBoard({ deps = defaultDeps(), now = Date.now(), apply = true } = {}) {
  // `getBoardConfig` is the real server-side Board config API — see the note in
  // services/homeTime/boardPresenceWatch.js for why the wrong name survived
  // every static check.
  const settings = await deps.boardSettings.getBoardConfig();
  const fresh = boardFreshness(settings, now);
  if (!fresh.ok) {
    await blocked(deps, fresh.reason);
    throw serviceError('BOARD_NOT_USABLE', `The driver roster could not be rebuilt: ${fresh.reason}.`, 409);
  }

  const [teams, layer, boardRows, current, eligible] = await Promise.all([
    loadTeams(deps),
    loadLayer(deps),
    deps.board.listBoardRows({ presentOnly: true, limit: 1000 }),
    deps.ra.listRosterForReconciliation(),
    loadEligibleDrivers(deps),
  ]);

  if (!teams.length) {
    await blocked(deps, 'no active dispatch team exists');
    throw serviceError('NO_TEAMS', 'The driver roster could not be rebuilt: no active dispatch team exists.', 409);
  }

  const { byDriver } = boardRowsByDriver(boardRows, layer);
  // The dispatcher cell is matched ONCE per row rather than per driver.
  for (const [, entry] of byDriver.entries()) {
    if (entry.duplicate) continue;
    entry.match = matchDispatcherToTeam(entry.dispatcher, teams);
  }

  const { actions, summary } = planRoster({ eligible, current, boardByDriver: byDriver });

  const reviews = [];
  const keptFindingIds = [];
  let placed = 0;
  let removed = 0;
  // TWO KINDS OF FAILURE, AND ONLY ONE OF THEM MAY BE SURVIVED. A roster WRITE
  // that failed means the roster is now part old and part new, which is the one
  // state this whole design exists to prevent — so it aborts below. A FINDING
  // that could not be filed costs visibility, not correctness: the driver is
  // genuinely off every roster either way, and refusing the whole review round
  // because a warning row would not insert trades a real problem for a bigger
  // one.
  const writeErrors = [];
  const errors = [];

  // A DRY RUN PLANS AND REPORTS, AND TOUCHES NOTHING. It exists because the
  // only way to see what reconciliation would do used to be to let it mint and
  // SEND a review round — so "check the roster is right first" and "do not send
  // a round you did not mean" were in direct conflict. The plan above is pure,
  // so this returns it without entering the write loop at all: no assignment
  // moves, no finding is filed, no `resolveClearedFindings` runs.
  if (!apply) {
    return {
      ok: true,
      dryRun: true,
      boardAgeMs: fresh.ageMs,
      teams: teams.length,
      summary: { ...summary, placed: 0, removed: 0 },
      reviews: actions
        .filter((a) => a.outcome === OUTCOME.REVIEW)
        .map((a) => ({
          driver: a.driver?.driverName || 'this driver',
          reason: a.reason,
          dispatcher: a.board?.dispatcher || null,
        })),
      wouldPlace: actions
        .filter((a) => a.outcome === OUTCOME.PLACE)
        .map((a) => ({
          driver: a.driver?.driverName || null,
          unitNumber: a.driver?.unitNumber || null,
          teamId: a.teamId,
          fromTeamId: a.fromTeamId ?? null,
          dispatcher: a.board?.dispatcher || null,
          via: a.board?.match?.via || null,
        })),
      errors: [],
    };
  }

  for (const action of actions) {
    try {
      if (action.outcome === OUTCOME.PLACE) {
        // eslint-disable-next-line no-await-in-loop
        const out = await deps.ra.applyBoardAssignment({
          teamId: action.teamId,
          personId: action.driver.personId,
          driverProfileId: action.driver.driverProfileId,
          groupId: action.driver.groupId,
          unitNumber: action.driver.unitNumber,
          driverName: action.driver.driverName,
          driverNormalizedName: action.driver.driverNormalizedName,
          boardDispatcher: action.board ? action.board.dispatcher : null,
          boardRowKey: action.board ? action.board.rowKey : null,
        });
        if (!out.heldByOverride) placed += 1;
      } else if (action.outcome === OUTCOME.REMOVE) {
        // eslint-disable-next-line no-await-in-loop
        if (await deps.ra.retireBoardAssignment(action.existing.id)) removed += 1;
      } else if (action.outcome === OUTCOME.REVIEW) {
        const who = action.driver?.driverName || 'this driver';
        // eslint-disable-next-line no-await-in-loop
        const filed = await deps.findings.upsertFinding({
          checkKey: CHECK_UNPLACED,
          subjectType: 'driver_person',
          subjectId: String(action.driver?.personId ?? action.driver?.groupId ?? who),
          title: reviewTitle(action.reason, who),
          severity: 'warning',
          tier: 'warning',
          evidence: {
            driver: who,
            reason: action.reason,
            boardDispatcher: action.board ? action.board.dispatcher : null,
            boardRowKey: action.board ? action.board.rowKey : null,
            currentTeamId: action.teamId,
            candidateTeamIds: action.board?.match?.candidates || [],
          },
          proposedChange: null,
        });
        if (filed?.id) keptFindingIds.push(filed.id);
        reviews.push({ driver: who, reason: action.reason, dispatcher: action.board?.dispatcher || null });
      }
    } catch (err) {
      const note = `${action.outcome}: ${err.message}`;
      errors.push(note);
      if (action.outcome !== OUTCOME.REVIEW) writeErrors.push(note);
    }
  }

  // A PARTIALLY REBUILT ROSTER IS THE THING THIS REFUSES TO SHIP. A constraint
  // violation or a dropped connection halfway through leaves some teams current
  // and others as they were last week, which is indistinguishable from a
  // correct rebuild to everybody who reads the review form. Throwing here is
  // what makes the caller's `openRoundAndPost` fail-closed real rather than
  // intended: the round is not minted, the scheduler releases its claim, and
  // the next tick tries again.
  if (writeErrors.length) {
    await blocked(deps, `${writeErrors.length} roster change(s) could not be written: ${writeErrors[0]}`);
    throw serviceError(
      'ROSTER_WRITE_FAILED',
      `The driver roster could not be rebuilt: ${writeErrors.length} change(s) could not be written.`,
      500
    );
  }

  // A DRIVER WHO IS NOW PLACED STOPS BEING A QUESTION. Without this the first
  // Sunday's unresolved list would stay on the Needs Attention page for ever,
  // which is how a screen full of solved problems teaches people to ignore it.
  await deps.findings.resolveClearedFindings([CHECK_UNPLACED], keptFindingIds);
  // The rebuild worked, so whatever was blocking it no longer is.
  await deps.findings.resolveClearedFindings([CHECK_ROSTER_BLOCKED], []);

  return {
    ok: true,
    boardAgeMs: fresh.ageMs,
    teams: teams.length,
    summary: { ...summary, placed, removed },
    reviews,
    errors,
  };
}

module.exports = {
  CHECK_UNPLACED, CHECK_ROSTER_BLOCKED, MAX_BOARD_AGE_HOURS,
  defaultDeps, loadTeams, loadLayer, boardRowsByDriver, loadEligibleDrivers, reviewTitle,
  boardFreshness, reconcileRosterFromBoard,
};
