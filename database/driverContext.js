'use strict';

/**
 * Assembling everything known about one driver, from the tables that know it.
 *
 * SIX READS, NOT SIX ROUND TRIPS PER CALLER. Each section is one small query
 * against an indexed column, and they run together. The pattern being avoided
 * is the one the fuel watch had: a per-driver lookup inside a loop over the
 * fleet, about a hundred round trips every pass to answer a question a single
 * query settles. A caller wanting the whole fleet should ask the features
 * directly rather than calling this a hundred times.
 *
 * A SECTION THAT CANNOT BE READ COMES BACK NULL, and `describeContext` turns
 * that into `known: false`. It must never come back as an empty section: "this
 * driver has no safety events" and "the safety query failed" produce identical
 * empty objects, and only one of them is a reason to relax.
 */
const { query } = require('./pool');
const { describeBoardStatus } = require('../lib/board/statusSemantics');
const { describeContext } = require('../lib/drivers/context');

/**
 * How long a board snapshot counts as current.
 *
 * ONE NUMBER, TWO READERS. `readBoard` refuses a staler row and the fleet-wide
 * screen refuses to offer one — and they have to agree, or the screen spends
 * six queries per driver per tick offering rows the reader then declines. It is
 * interpolated into the screen's SQL rather than passed as a parameter because
 * that query already numbers its placeholders and a third would renumber them;
 * it is a module constant and never reaches this file from outside.
 */
const BOARD_FRESH_HOURS = 2;

/** Each section catches its own failure, so one bad table cannot blank the page. */
async function safely(fn) {
  try {
    return await fn();
  } catch (_) {
    return null;
  }
}

async function readIdentity(personId) {
  const res = await query(
    `SELECT p.display_name,
            ARRAY_REMOVE(ARRAY_AGG(DISTINCT u.unit_number) FILTER (WHERE u.ended_at IS NULL), NULL)
              AS open_units,
            ARRAY_REMOVE(ARRAY_AGG(DISTINCT g.group_id) FILTER (WHERE g.ended_at IS NULL), NULL)
              AS open_groups
       FROM driver_people p
       LEFT JOIN driver_units u ON u.person_id = p.id
       LEFT JOIN driver_person_groups g ON g.person_id = p.id
      WHERE p.id = $1
      GROUP BY p.display_name`,
    [personId]
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    displayName: row.display_name,
    openUnits: (row.open_units || []).map(String),
    openGroups: (row.open_groups || []).map(Number),
  };
}

async function readHomeTime(personId) {
  const res = await query(
    `SELECT s.state, s.state_since
       FROM driver_home_status s
       JOIN driver_person_groups g ON g.group_id = s.group_id AND g.ended_at IS NULL
      WHERE g.person_id = $1
      ORDER BY s.state_since DESC NULLS LAST
      LIMIT 1`,
    [personId]
  );
  const row = res.rows[0];
  if (!row) return null;
  return { state: row.state, stateSince: row.state_since };
}

async function readLoads(personId) {
  // Only a phase that means the truck is WORKING counts as movement here. A
  // load sitting `assigned` is not a contradiction with being at home; one
  // `in_transit` is.
  const res = await query(
    `SELECT l.order_id, l.phase
       FROM load_lifecycle l
       JOIN driver_person_groups g ON g.group_id = l.group_id AND g.ended_at IS NULL
      WHERE g.person_id = $1
        AND l.phase IN ('heading_to_pickup', 'at_pickup', 'in_transit', 'at_delivery')
      ORDER BY l.updated_at DESC
      LIMIT 1`,
    [personId]
  );
  const row = res.rows[0];
  return { movingPhase: row ? row.phase : null, orderId: row ? row.order_id : null };
}

async function readFuel(personId) {
  const res = await query(
    `SELECT fuel_percent, odometer_miles, recorded_at
       FROM truck_fuel_readings
      WHERE person_id = $1
      ORDER BY recorded_at DESC NULLS LAST
      LIMIT 1`,
    [personId]
  );
  const row = res.rows[0];
  return {
    fuelPercent: row ? row.fuel_percent : null,
    odometerMiles: row ? row.odometer_miles : null,
    newestReadingAt: row ? row.recorded_at : null,
  };
}

async function readSafety(personId, { windowDays = 30 } = {}) {
  const res = await query(
    `SELECT COUNT(*)::int AS events, MAX(occurred_at) AS newest
       FROM driver_safety_events
      WHERE person_id = $1 AND occurred_at > NOW() - ($2 || ' days')::interval`,
    [personId, String(windowDays)]
  );
  const row = res.rows[0] || {};
  return { events: row.events || 0, newestEventAt: row.newest || null, windowDays };
}

/**
 * THE COLUMNS THIS ASKED FOR DID NOT EXIST.
 *
 * It selected `urgency` and `assessed_at`, and `driver_retention_assessments`
 * has neither — it has `level` and `first_seen_at` / `last_seen_at`. The query
 * raised `column "urgency" does not exist` on every call, `safely()` turned
 * that into `null`, and the retention section came back `known: false` for
 * every driver in the fleet, for ever.
 *
 * So `quiet_but_active` — the contradiction this module's own header calls the
 * most valuable one, because it tells a driver who stopped working apart from
 * a feed that stopped reporting — COULD NEVER FIRE. The module looked finished
 * and its best rule was unreachable, which is the same defect as a watch that
 * returned a hard-coded null and made its abnormal-burn branch dead.
 *
 * It survived review because nothing called this module at all, and it would
 * have survived the first caller too: a swallowed failure and an honest absence
 * are the same `{known: false}` from outside. That is the cost of `safely`, and
 * it is still the right trade — but it means the queries under it have to be
 * checked against the schema rather than assumed, and a test has to assert the
 * section comes back READABLE rather than merely not throwing.
 */
async function readRetention(personId) {
  const res = await query(
    `SELECT signals, level, last_seen_at, first_seen_at
       FROM driver_retention_assessments
      WHERE person_id = $1
      ORDER BY last_seen_at DESC NULLS LAST LIMIT 1`,
    [personId]
  );
  const row = res.rows[0];
  if (!row) return { goneQuiet: false, urgency: null, assessedAt: null, signals: 0 };
  const signals = Array.isArray(row.signals) ? row.signals : [];
  return {
    // `key`, WHICH IS THE FIELD THAT EXISTS. `lib/retention/signals.js`
    // builds every signal as `{ key, weight, detail, evidence }`, and this read
    // `s.kind` — always undefined, so `String(undefined || s)` produced
    // "[object Object]" and `goneQuiet` was false for every driver who ever
    // went quiet. The rule this whole module calls its most valuable, fixed
    // once already in the same file, still could not fire.
    //
    // It survived because the test seeded `{ kind: 'gone_quiet' }` — the shape
    // the broken reader wanted rather than the shape production writes. The
    // test now builds its fixture through `assess()` itself, so the two cannot
    // drift apart again.
    //
    // `kind` is still accepted: it costs nothing and an older row, if any
    // exists, should not silently read as "not quiet".
    goneQuiet: signals.some((s) => String(s?.key || s?.kind || s).includes('quiet')),
    // WHEN THE ASSESSMENT FIRST APPEARED — WHICH IS NOT THE SAME AS WHEN THEY
    // WENT QUIET, and it is named accordingly.
    //
    // `recordAssessment` upserts one row per driver for their whole life and
    // never resets `first_seen_at` when signals come and go, so a driver
    // assessed for months who went quiet yesterday carries a months-old date.
    // `last_seen_at` is worse — it moves every sweep, so everyone would read as
    // having gone quiet fifteen minutes ago.
    //
    // Neither is the onset, and there is no per-signal history to derive one
    // from, so this no longer claims to be one. A notice that said "quiet since
    // March" about somebody who went quiet on Tuesday would be a fabricated
    // fact, which is worse than not saying when.
    assessmentSince: row.first_seen_at,
    goneQuietSince: null,
    urgency: row.level,
    assessedAt: row.last_seen_at,
    signals: signals.length,
  };
}

/**
 * Who might have a contradiction, in ONE query over the whole fleet.
 *
 * THE COST THIS EXISTS TO AVOID. `getDriverContext` is six queries. Calling it
 * for every driver on a fifteen-minute timer would be roughly 110 × 6 × 96 =
 * 63,000 queries a day against a free-tier database, to answer a question that
 * is almost always "no" — and it is exactly the per-driver-lookup-in-a-loop
 * this module's own header warns about, committed by its first caller.
 *
 * So: a cheap set-based screen first, and the expensive read only for the
 * handful it returns.
 *
 * THE SCREEN MAY OVER-SELECT AND MUST NEVER UNDER-SELECT. It is deliberately
 * looser than `findContradictions`, which is the thing that actually decides —
 * `signals::text ILIKE '%quiet%'` catches every shape the JS predicate would,
 * and some it would not. A false candidate costs six queries and produces no
 * finding. A missed one is a contradiction nobody ever hears about.
 *
 * TWO BRANCHES, FOR THREE CONTRADICTIONS, AND THE MISSING ONE IS DELIBERATE.
 * `two_open_units` is not representable: migration 0015 created
 * `uniq_driver_units_open_person ON driver_units (person_id) WHERE ended_at IS
 * NULL`, so a person cannot have two trucks open and a screen for it would run
 * every fifteen minutes and find nothing for ever. The JS check stays — it
 * costs nothing, reading a list already in hand, and it is the one thing that
 * would notice if that index were ever dropped — but it does not get a query.
 *
 * A fourth kind added to `findContradictions` needs a branch here, and the test
 * that seeds one driver per kind is what makes forgetting that visible.
 */
async function listContradictionCandidates({ limit = 200, activeWithinHours = 12 } = {}) {
  const res = await query(
    `-- at home, and simultaneously working
     SELECT DISTINCT g.person_id
       FROM driver_person_groups g
       JOIN driver_home_status s ON s.group_id = g.group_id
       JOIN load_lifecycle l ON l.group_id = g.group_id
      WHERE g.ended_at IS NULL
        AND g.person_id IS NOT NULL
        AND s.state = 'home'
        AND l.phase IN ('heading_to_pickup', 'at_pickup', 'in_transit', 'at_delivery')
     UNION
     -- called quiet by one feature while another shows them plainly working
     SELECT DISTINCT r.person_id
       FROM driver_retention_assessments r
      WHERE r.person_id IS NOT NULL
        AND r.signals::text ILIKE '%quiet%'
        AND (
          EXISTS (SELECT 1 FROM truck_fuel_readings f
                   WHERE f.person_id = r.person_id
                     AND f.recorded_at > NOW() - ($1 || ' hours')::interval)
          OR EXISTS (SELECT 1 FROM driver_safety_events e
                      WHERE e.person_id = r.person_id
                        AND e.occurred_at > NOW() - ($1 || ' hours')::interval)
          -- A MOVING LOAD IS ACTIVITY TOO, and the evaluator has always counted
          -- it. Screening on fuel and safety alone meant a quiet-marked driver
          -- whose truck is plainly in transit — no recent fuel reading, no
          -- safety event — was never read, so the contradiction the screen
          -- exists to surface was the one it could not see.
          OR EXISTS (SELECT 1 FROM load_lifecycle l
                       JOIN driver_person_groups pg
                         ON pg.group_id = l.group_id AND pg.ended_at IS NULL
                      WHERE pg.person_id = r.person_id
                        AND l.phase IN ('heading_to_pickup', 'at_pickup',
                                        'in_transit', 'at_delivery'))
        )
     UNION
     -- the board says home, Wenze says road (and the reverse)
     --
     -- SCREENED ON THE SAME TWO FRESHNESS AND PRESENCE RULES readBoard uses.
     -- A screen that offered rows the reader then refuses would cost six
     -- queries per driver to produce nothing, every tick, for ever.
     SELECT DISTINCT b.person_id
       FROM dispatch_board_rows b
       JOIN driver_person_groups g
         ON g.person_id = b.person_id AND g.ended_at IS NULL
       JOIN driver_home_status s ON s.group_id = g.group_id
      WHERE b.person_id IS NOT NULL
        AND b.present = TRUE
        AND b.last_seen_at > NOW() - INTERVAL '${BOARD_FRESH_HOURS} hours'
        AND (
          (b.status IN ('HOME', 'VACATION') AND s.state = 'road')
          OR (b.status IN ('DISPATCHED', 'ENROUTE') AND s.state = 'home')
        )
     -- ORDERED, SO THE OVER-CAP TAIL IS NOT THE SAME ROWS FOR EVER.
     --
     -- With no ORDER BY, PostgreSQL may return the same subset every tick, and
     -- the caller slices the first N — so candidates past the cap could go
     -- unread indefinitely while the log said more remained. Ordering by
     -- person_id at least makes the set deterministic; the caller rotates
     -- through it, because a cursor for a set this small would cost more than
     -- it saves.
     ORDER BY 1
     LIMIT $2`,
    [String(Math.max(1, Number(activeWithinHours) || 12)), Math.max(1, Math.min(1000, limit))]
  );
  return res.rows.map((r) => Number(r.person_id));
}

/**
 * What the Dispatcher Board says about this driver right now.
 *
 * TWO RULES, BOTH ABOUT REFUSING TO ANSWER.
 *
 * ONLY A ROW STILL ON THE BOARD. An absent row is history — it is kept so a
 * vanished assignment leaves a trace, and reading it here would have the board
 * "saying" something it stopped saying days ago.
 *
 * STALE READS AS `unknown`, NEVER AS A SIDE. The poller runs every few minutes;
 * a snapshot older than two hours means it stopped, and a stopped poller must
 * not be quoted as evidence against Home Time. `unknown` and `hold` are
 * opposites here exactly as they are in the decision journal: "nobody has
 * looked" is not "the board disagrees".
 *
 * Returns null — a section marked `known: false` upstream — rather than
 * throwing, so a deploy that has not applied 0046 costs the board's opinion and
 * not the whole context.
 */
async function readBoard(personId) {
  try {
    const res = await query(
      `SELECT status, status_raw, truck_norm, board_trailer, eta_text, dispatcher,
              last_seen_at
         FROM dispatch_board_rows
        WHERE person_id = $1 AND present = TRUE
          AND last_seen_at > NOW() - ($2 || ' hours')::interval
        ORDER BY last_seen_at DESC
        LIMIT 1`,
      [personId, String(BOARD_FRESH_HOURS)]
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      status: row.status,
      statusRaw: row.status_raw,
      says: describeBoardStatus(row.status),
      truck: row.truck_norm,
      trailer: row.board_trailer,
      etaText: row.eta_text,
      dispatcher: row.dispatcher,
      lastSeenAt: row.last_seen_at,
    };
  } catch (_) {
    return null;
  }
}

/**
 * Everything known about one driver, with the gaps marked as gaps.
 *
 * @param {number} personId
 * @returns {Promise<object>} a context from `lib/drivers/context.js`
 */
async function getDriverContext(personId) {
  if (!personId) return describeContext({});
  const [identity, homeTime, loads, fuel, safety, retention, board] = await Promise.all([
    safely(() => readIdentity(personId)),
    safely(() => readHomeTime(personId)),
    safely(() => readLoads(personId)),
    safely(() => readFuel(personId)),
    safely(() => readSafety(personId)),
    safely(() => readRetention(personId)),
    safely(() => readBoard(personId)),
  ]);
  return describeContext({ personId, identity, homeTime, loads, fuel, safety, retention, board });
}

module.exports = { getDriverContext, listContradictionCandidates, BOARD_FRESH_HOURS };
