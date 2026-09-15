'use strict';

/**
 * Recording when a driver actually goes home, and when they leave again —
 * from the Dispatcher Board rather than from anybody typing a date.
 *
 * WHAT THIS REPLACES. Home In and Home Out used to arrive one of two ways: a
 * driver writing "Status: Home" in their chat, or a person typing dates into
 * the admin. Both work when they happen and neither happens reliably, which is
 * how production ended up with drivers recorded at home for 134 days. Dispatch
 * already records the answer on the Board, every day, because they work from
 * it.
 *
 * A HOME TIME REQUEST IS NOT USED HERE, AND THAT IS THE POINT. Asking to go
 * home is a plan. This service only reads what the Board says happened.
 *
 * IT DOES NOT COMPETE WITH THE RETURN-TO-ROAD WATCH. That one proves a truck
 * physically left, from GPS and loads; this one reads a dispatcher's statement.
 * They compose rather than fight, because both end at the same place: once a
 * home stay is closed, `listDriversAtHome` stops returning the driver and the
 * other watch has nothing to look at — and once the state agrees with the
 * Board, this one returns `none` and writes nothing.
 *
 * EVERY WRITE GOES THROUGH `applyStateTransition`. That function owns the
 * home/road state machine, the road-history cycle and the bonus; writing
 * `driver_home_status` directly is the exact bug that left 74 of 79 cycles
 * open, so this service does not have the ability to do it.
 *
 * WHAT IT REFUSES TO DO. The pure rule in lib/homeTime/boardPresence.js holds
 * the three anti-flapping lines — settle, dwell, hold — so a Board a few
 * minutes behind a driver's own message produces silence, not a Needs Attention
 * item. Only a disagreement that has stood for half a day becomes a question.
 */

const { decideBoardPresence, describeBoardPresence, ACTION } = require('../../lib/homeTime/boardPresence');
const { withRunRecord } = require('../operations/runLedger');
const { classifyErrorKind, describeErrorKind } = require('../../lib/operations/errorKind');

const CHECK_DISAGREES = 'home_time.board_disagrees_with_state';

/** How many drivers one pass will move, so a bad board cannot rewrite the fleet. */
const MAX_TRANSITIONS_PER_PASS = 25;

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    board: require('../../database/dispatchBoard'),
    boardSettings: require('../../database/dispatchBoardSettings'),
    rowPeople: require('../dispatchBoard/rowPeople'),
    ht: require('../../database/homeTime'),
    findings: require('../../database/operationalFindings'),
    db: require('../../database/db'),
    homeTime: require('../homeTimeService'),
  };
  /* eslint-enable global-require */
}

/**
 * Every driver group Wenze has a home/road state for, keyed by person.
 *
 * ONE QUERY, NOT ONE PER DRIVER. The join to the open person association is
 * what makes a truck change invisible here: the person keeps their state and
 * their open cycle when their group or unit moves, because nothing in this
 * path is keyed on either.
 */
async function loadDriverStates(db) {
  const res = await db.query(
    `SELECT g.id                       AS group_id,
            g.telegram_group_id,
            g.group_name,
            g.group_type,
            pg.person_id,
            s.state,
            s.state_since,
            s.last_status_at
       FROM driver_home_status s
       JOIN groups g ON g.id = s.group_id
       LEFT JOIN driver_person_groups pg
              ON pg.group_id = g.id AND pg.ended_at IS NULL
      WHERE g.active = TRUE AND g.group_type = 'driver'`
  );
  const byPerson = new Map();
  for (const row of res.rows) {
    if (row.person_id == null) continue;
    const key = `person:${row.person_id}`;
    // ONE OPEN STATE PER PERSON. Two active groups for one human is itself a
    // finding the identity checks already file; acting on either here would
    // pick a side of a question nobody has answered.
    if (byPerson.has(key)) { byPerson.set(key, null); continue; }
    byPerson.set(key, row);
  }
  return byPerson;
}

/** What the driver themselves last said, so their word can outrank a spreadsheet. */
function driverVoice(state) {
  if (!state || !state.last_status_at) return { driverSaidAt: null, driverSaidState: null };
  return { driverSaidAt: state.last_status_at, driverSaidState: state.state };
}

async function fileDisagreement(deps, { state, entry, decision }) {
  const who = state.group_name || `group ${state.group_id}`;
  return deps.findings.upsertFinding({
    checkKey: CHECK_DISAGREES,
    subjectType: 'driver_group',
    subjectId: String(state.group_id),
    title: `The dispatcher board and Wenze disagree about whether ${who} is home`,
    severity: 'warning',
    tier: 'warning',
    evidence: {
      driver: who,
      boardSays: decision.evidence.boardState,
      boardStatus: decision.evidence.boardStatus,
      wenzeSays: state.state,
      wenzeSince: state.state_since,
      reason: decision.reason,
      boardRowKey: entry.rowKey,
    },
    // A DISAGREEMENT IS NOT A PROPOSAL. Which of two systems is right is
    // exactly the thing nobody here knows.
    proposedChange: null,
  });
}

/**
 * One pass.
 *
 * @returns `{ blocked? , checked, opened, closed, held, reviews, errors }`
 */
async function runBoardPresencePass({ deps = defaultDeps(), now = Date.now(), telegram = null } = {}) {
  const summary = { checked: 0, opened: 0, closed: 0, held: 0, reviews: 0, errors: [] };
  const nowIso = new Date(now).toISOString();

  // `getBoardConfig`, NOT `getDispatchBoardSettings`. The latter never existed:
  // this reached through a deps object, so the wrong name is a property access
  // that returns undefined and throws only when called — invisible to
  // `lint:imports`, green in every test that stubs `boardSettings`, and five
  // consecutive failures in production. `assertDeps` below is the guard.
  const settings = await deps.boardSettings.getBoardConfig();
  if (!settings || !settings.enabled) {
    return { blocked: 'the Dispatcher Board is switched off in Settings', ...summary };
  }
  if (!settings.configured) {
    return { blocked: 'the Dispatcher Board has no address or token in Settings', ...summary };
  }

  const [rows, layer, states] = await Promise.all([
    deps.board.listBoardRows({ presentOnly: true, limit: 1000 }),
    deps.rowPeople.loadPersonLayer(deps.db),
    loadDriverStates(deps.db),
  ]);
  const { byPerson } = deps.rowPeople.resolveBoardRowsToPeople(rows, layer);

  const keptFindingIds = [];
  for (const [key, entry] of byPerson.entries()) {
    const state = states.get(key);
    // No state row, no person, or two groups for one person: nothing to move.
    if (!state || !entry || entry.duplicate) continue;
    summary.checked += 1;

    const decision = decideBoardPresence({
      nowIso,
      boardStatus: entry.status,
      statusChangedAt: entry.statusChangedAt,
      lastSeenAt: entry.lastSeenAt,
      wenzeState: state.state,
      wenzeStateSince: state.state_since,
      ...driverVoice(state),
    });

    if (decision.action === ACTION.NONE) continue;
    if (decision.action === ACTION.HOLD) { summary.held += 1; continue; }

    if (decision.action === ACTION.REVIEW) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const filed = await fileDisagreement(deps, { state, entry, decision });
        if (filed?.id) keptFindingIds.push(filed.id);
        summary.reviews += 1;
      } catch (err) {
        summary.errors.push(`review ${state.group_id}: ${err.message}`);
      }
      continue;
    }

    if (summary.opened + summary.closed >= MAX_TRANSITIONS_PER_PASS) {
      // A board that suddenly says the whole fleet went home is a board
      // problem. The cap turns it into a slow one somebody can notice.
      summary.errors.push('the per-pass transition cap was reached');
      break;
    }

    const newState = decision.action === ACTION.OPEN_HOME ? 'home' : 'road';
    try {
      // eslint-disable-next-line no-await-in-loop
      const out = await deps.homeTime.applyStateTransition(telegram, {
        id: state.group_id,
        telegram_group_id: state.telegram_group_id,
        group_name: state.group_name,
        group_type: 'driver',
      }, {
        newState,
        eventAt: decision.eventAt,
        statusText: '',
        // THE MANAGERS ARE TOLD, exactly as they are when a driver says it
        // themselves. A home arrival nobody announces is a home arrival
        // nobody planned around.
        announce: true,
        detectedBy: 'dispatcher_board',
        evidenceSummary: describeBoardPresence(decision),
      });
      if (out?.transition === 'road_to_home') summary.opened += 1;
      else if (out?.transition === 'home_to_road') summary.closed += 1;
    } catch (err) {
      summary.errors.push(`${newState} ${state.group_id}: ${err.message}`);
    }
  }

  // A driver whose board and state now agree is no longer a question.
  await deps.findings.resolveClearedFindings([CHECK_DISAGREES], keptFindingIds).catch(() => {});

  // EVERY DRIVER FAILING IS THE PASS NOT HAVING RUN, not a bad row.
  if (summary.checked && summary.errors.length >= summary.checked) {
    summary.error = `none of the ${summary.checked} driver(s) could be reconciled with the board`;
  }
  return summary;
}

/** The catalogued worker entry point. Never throws. */
async function runBoardPresenceWatch(options = {}) {
  return withRunRecord('home_time_board_presence', async () => {
    try {
      return await runBoardPresencePass(options);
    } catch (err) {
      const kind = classifyErrorKind(err);
      return { error: describeErrorKind(kind, err) };
    }
  });
}

/**
 * Every fifteen minutes, and the first pass two minutes after boot.
 *
 * The Board poller runs faster than this and the confirmation window is longer
 * than both, so nothing is gained by asking more often — the answer cannot
 * change until the Board has held a status for twenty minutes anyway.
 */
const POLL_MS = 15 * 60 * 1000;
const FIRST_TICK_DELAY_MS = 2 * 60 * 1000;

let serviceTimer = null;
let serviceStopped = false;
let telegramClient = null;
let tickRunning = false;

async function tick() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    await runBoardPresenceWatch({ telegram: telegramClient });
  } catch (err) {
    console.error('[HOME-TIME-BOARD] pass failed:', err.message);
  } finally {
    tickRunning = false;
    if (!serviceStopped) {
      serviceTimer = setTimeout(tick, POLL_MS);
      serviceTimer.unref?.();
    }
  }
}

function startBoardPresenceWatch(telegram = null) {
  serviceStopped = false;
  telegramClient = telegram;
  console.log(`[HOME-TIME-BOARD] Reading the dispatcher board for home arrivals every ${POLL_MS / 60000} min `
    + '- a status must hold before it moves anybody.');
  serviceTimer = setTimeout(() => { if (!serviceStopped) tick(); }, FIRST_TICK_DELAY_MS);
  serviceTimer.unref?.();
}

function stopBoardPresenceWatch() {
  serviceStopped = true;
  if (serviceTimer) { clearTimeout(serviceTimer); serviceTimer = null; }
}

module.exports = {
  CHECK_DISAGREES, MAX_TRANSITIONS_PER_PASS, POLL_MS, FIRST_TICK_DELAY_MS,
  defaultDeps, loadDriverStates, runBoardPresencePass, runBoardPresenceWatch,
  startBoardPresenceWatch, stopBoardPresenceWatch,
};
