'use strict';

/**
 * The roster rebuild against a real PostgreSQL.
 *
 * FOUR THINGS ONLY THE DATABASE CAN PROVE, and each of them is a guarantee the
 * owner asked for by name:
 *   a move closes the old row instead of leaving a driver on two teams,
 *   a second pass over the same board writes nothing new (idempotent),
 *   a manual row is refused under lock, not merely skipped by the planner, and
 *   a completed round's recorded picks are untouched by any of it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { raiseApproval: ra } = h.loadDataLayer(['raiseApproval']);
  const teamA = (await h.query("INSERT INTO dispatch_teams (name) VALUES ('Charles') RETURNING id")).rows[0].id;
  const teamB = (await h.query("INSERT INTO dispatch_teams (name) VALUES ('Steven') RETURNING id")).rows[0].id;
  const person = (await h.query(
    "INSERT INTO driver_people (display_name, normalized_key) VALUES ('JOHN SMITH','johnsmith') RETURNING id"
  )).rows[0].id;
  return { h, ra, teamA, teamB, person };
}

const DRIVER = (teamId, personId) => ({
  teamId, personId, driverProfileId: null, groupId: null, unitNumber: '310',
  driverName: 'JOHN SMITH', driverNormalizedName: 'JOHN SMITH',
  boardDispatcher: 'Charles', boardRowKey: '310|JOHN SMITH',
});

test('the migration adds every column the rebuild writes, and is safe to re-run', async (t) => {
  if (skipWithoutPg(t)) return;
  const { h } = await setup(t);
  const cols = (await h.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'dispatch_team_drivers'`
  )).rows.map((r) => r.column_name);
  for (const c of ['assignment_source', 'board_dispatcher', 'board_row_key', 'reconciled_at',
    'manual_override_at', 'manual_override_by', 'review_reason']) {
    assert.ok(cols.includes(c), `${c} is missing`);
  }
  // Re-running every migration must be a no-op, because they run at boot.
  await h.applySchemaSql(ALL_MIGRATIONS);
  await assert.rejects(
    h.query("INSERT INTO dispatch_team_drivers (team_id, driver_normalized_name, driver_name, assignment_source) VALUES (1,'X','X','guess')"),
    /assignment_source/
  );
});

test('a board placement lands, and a second identical pass changes nothing', async (t) => {
  if (skipWithoutPg(t)) return;
  const { h, ra, teamA, person } = await setup(t);

  const first = await ra.applyBoardAssignment(DRIVER(teamA, person));
  assert.equal(first.moved, false);
  const second = await ra.applyBoardAssignment(DRIVER(teamA, person));
  assert.equal(second.moved, false);

  const rows = (await h.query('SELECT * FROM dispatch_team_drivers WHERE active')).rows;
  assert.equal(rows.length, 1, 'running the reconciliation twice made one row, not two');
  assert.equal(rows[0].assignment_source, 'board');
  assert.equal(rows[0].board_dispatcher, 'Charles');
  assert.ok(rows[0].reconciled_at);
});

test('a move closes the old row — a driver is never on two teams at once', async (t) => {
  if (skipWithoutPg(t)) return;
  const { h, ra, teamA, teamB, person } = await setup(t);

  await ra.applyBoardAssignment(DRIVER(teamA, person));
  const moved = await ra.applyBoardAssignment({
    ...DRIVER(teamB, person), boardDispatcher: 'Steven',
  });
  assert.equal(moved.moved, true);
  assert.equal(moved.fromTeamId, teamA);

  const active = (await h.query('SELECT team_id FROM dispatch_team_drivers WHERE active')).rows;
  assert.deepEqual(active.map((r) => r.team_id), [teamB]);
  const all = (await h.query('SELECT COUNT(*)::int AS n FROM dispatch_team_drivers')).rows[0].n;
  assert.equal(all, 2, 'the old row is kept, closed — it is the record of where they were');
});

test('a human override is refused under lock, not merely skipped by the planner', async (t) => {
  if (skipWithoutPg(t)) return;
  const { h, ra, teamA, teamB, person } = await setup(t);

  const placed = await ra.applyBoardAssignment(DRIVER(teamA, person));
  await ra.markManualOverride(placed.id, 'admin:jane');

  const held = await ra.applyBoardAssignment({ ...DRIVER(teamB, person), boardDispatcher: 'Steven' });
  assert.equal(held.heldByOverride, true);
  assert.equal(held.fromTeamId, teamA);

  const row = (await h.query('SELECT * FROM dispatch_team_drivers WHERE active')).rows[0];
  assert.equal(row.team_id, teamA, 'the board did not win');
  assert.equal(row.manual_override_by, 'admin:jane');
  assert.ok(row.manual_override_at);
});

test('handing the driver back makes the board the owner again on the next pass', async (t) => {
  if (skipWithoutPg(t)) return;
  const { h, ra, teamA, teamB, person } = await setup(t);

  const placed = await ra.applyBoardAssignment(DRIVER(teamA, person));
  await ra.markManualOverride(placed.id, 'admin:jane');
  const released = await ra.clearManualOverride(placed.id);
  assert.equal(released.assignment_source, 'board');
  assert.equal(released.manual_override_by, null);

  await ra.applyBoardAssignment({ ...DRIVER(teamB, person), boardDispatcher: 'Steven' });
  const row = (await h.query('SELECT team_id FROM dispatch_team_drivers WHERE active')).rows[0];
  assert.equal(row.team_id, teamB);
});

test('retiring only ever touches a board row, never somebody’s decision', async (t) => {
  if (skipWithoutPg(t)) return;
  const { h, ra, teamA, person } = await setup(t);

  const placed = await ra.applyBoardAssignment(DRIVER(teamA, person));
  await ra.markManualOverride(placed.id, 'admin:jane');
  assert.equal(await ra.retireBoardAssignment(placed.id), false);
  assert.equal((await h.query('SELECT active FROM dispatch_team_drivers WHERE id = $1', [placed.id])).rows[0].active, true);

  await ra.clearManualOverride(placed.id);
  assert.equal(await ra.retireBoardAssignment(placed.id), true);
  assert.equal(await ra.retireBoardAssignment(placed.id), false, 'retiring twice is a no-op');
});

test('the reconciliation roster reports the source so the plan can honour an override', async (t) => {
  if (skipWithoutPg(t)) return;
  const { ra, teamA, teamB, person } = await setup(t);

  const a = await ra.applyBoardAssignment(DRIVER(teamA, person));
  await ra.markManualOverride(a.id, 'admin:jane');
  const other = (await ra.applyBoardAssignment({
    ...DRIVER(teamB, null), driverNormalizedName: 'MARIA GARCIA', driverName: 'MARIA GARCIA',
  }));

  const roster = await ra.listRosterForReconciliation();
  assert.equal(roster.length, 2);
  const mine = roster.find((r) => r.id === a.id);
  const theirs = roster.find((r) => r.id === other.id);
  assert.equal(mine.assignmentSource, 'manual');
  assert.equal(mine.manualOverrideBy, 'admin:jane');
  assert.equal(theirs.assignmentSource, 'board');
});

test('a submitted round keeps the drivers it actually had — history is not rewritten', async (t) => {
  if (skipWithoutPg(t)) return;
  const { h, ra, teamA, teamB, person } = await setup(t);

  await ra.applyBoardAssignment(DRIVER(teamA, person));
  const round = (await h.query(
    `INSERT INTO raise_rounds (period_start, period_end, access_token, expires_at, rate_low, rate_high)
     VALUES ('2026-09-01','2026-09-07','tok', NOW() + INTERVAL '2 days', 0.72, 0.75) RETURNING id`
  )).rows[0].id;
  const submission = (await h.query(
    `INSERT INTO raise_round_submissions (round_id, team_id, dispatcher_name, dispatcher_contact, contact_type)
     VALUES ($1,$2,'Charles','c@x.test','email') RETURNING id`, [round, teamA]
  )).rows[0].id;
  await h.query(
    `INSERT INTO raise_round_picks (submission_id, round_id, team_id, driver_normalized_name, driver_name, qualified)
     VALUES ($1,$2,$3,'JOHN SMITH','JOHN SMITH', TRUE)`, [submission, round, teamA]
  );

  // The board now says somebody else dispatches them; the rebuild moves them.
  await ra.applyBoardAssignment({ ...DRIVER(teamB, person), boardDispatcher: 'Steven' });

  const picks = (await h.query(
    'SELECT p.driver_normalized_name, p.team_id FROM raise_round_picks p'
  )).rows;
  assert.deepEqual(picks, [{ driver_normalized_name: 'JOHN SMITH', team_id: teamA }],
    'the completed review still shows the team and driver it was answered for');
});

// ─── legacy rows must not block the rebuild for ever (production defect) ───

test('migration 0062 hands legacy rows back to the board and leaves real overrides alone', async (t) => {
  if (skipWithoutPg(t)) return;
  const { h, ra, teamA, person } = await setup(t);

  // 0062 reads the ledger to learn WHEN 0058 landed, so the window has to be
  // real: the harness applies migration SQL directly and never writes the
  // ledger, so seed the one row 0062 asks about.
  await h.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY, checksum TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'versioned',
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), execution_ms INTEGER)`);
  await h.query(
    `INSERT INTO schema_migrations (version, checksum, kind, applied_at)
     VALUES ('0058_raise_roster_from_board', 'test', 'versioned', NOW() - INTERVAL '10 days')
     ON CONFLICT (version) DO UPDATE SET applied_at = EXCLUDED.applied_at`
  );

  const legacy = await ra.applyBoardAssignment(DRIVER(teamA, person));
  const decided = (await h.query(
    `INSERT INTO dispatch_team_drivers
       (team_id, driver_normalized_name, driver_name, active, assignment_source, manual_override_at, manual_override_by)
     VALUES ($1,'MARIA GARCIA','MARIA GARCIA', TRUE, 'manual', NOW(), 'admin:jane') RETURNING id`,
    [teamA]
  )).rows[0].id;
  // A row typed through PUT /teams/:id/drivers AFTER the Board work landed but
  // before `setTeamDrivers` learned to stamp: manual, no mark, and yet a real
  // decision. The timestamp alone cannot tell it from a legacy row — only its
  // age can, which is why 0062 also asks when 0058 was applied.
  const unstamped = (await h.query(
    `INSERT INTO dispatch_team_drivers
       (team_id, driver_normalized_name, driver_name, active, assignment_source, updated_at)
     VALUES ($1,'LEE BRANNIGAN','LEE BRANNIGAN', TRUE, 'manual', NOW()) RETURNING id`,
    [teamA]
  )).rows[0].id;
  // Make the first row look like one migration 0058 stamped: manual, no mark,
  // and untouched since before 0058 ran.
  await h.query(
    `UPDATE dispatch_team_drivers
        SET assignment_source = 'manual', manual_override_at = NULL,
            updated_at = NOW() - INTERVAL '30 days'
      WHERE id = $1`,
    [legacy.id]
  );

  await h.applySchemaSql(ALL_MIGRATIONS);

  const rows = (await h.query(
    'SELECT id, assignment_source, manual_override_by FROM dispatch_team_drivers ORDER BY id'
  )).rows;
  const back = rows.find((r) => r.id === legacy.id);
  const kept = rows.find((r) => r.id === decided);
  const recent = rows.find((r) => r.id === unstamped);
  assert.equal(back.assignment_source, 'board', 'a row with no mark follows the board again');
  assert.equal(kept.assignment_source, 'manual', "a person's decision is untouched");
  assert.equal(kept.manual_override_by, 'admin:jane');
  assert.equal(recent.assignment_source, 'manual',
    'a roster typed since the Board work landed is a decision, not an inheritance');
});

test('migration 0062 does NOTHING when it cannot date the Board work', async (t) => {
  if (skipWithoutPg(t)) return;
  const { h, ra, teamA, person } = await setup(t);
  // No 0058 row in the ledger. Without it there is no way to tell a legacy row
  // from an unstamped decision, and the safe way to be wrong is to change
  // nothing rather than to hand somebody's roster to the Board.
  const legacy = await ra.applyBoardAssignment(DRIVER(teamA, person));
  await h.query(
    `UPDATE dispatch_team_drivers
        SET assignment_source = 'manual', manual_override_at = NULL,
            updated_at = NOW() - INTERVAL '30 days'
      WHERE id = $1`,
    [legacy.id]
  );

  await h.applySchemaSql(ALL_MIGRATIONS);

  const row = (await h.query(
    'SELECT assignment_source FROM dispatch_team_drivers WHERE id = $1', [legacy.id]
  )).rows[0];
  assert.equal(row.assignment_source, 'manual', 'nothing is moved on a guess');
});

test('a legacy row does not hold the board off under lock', async (t) => {
  if (skipWithoutPg(t)) return;
  const { h, ra, teamA, teamB, person } = await setup(t);

  const placed = await ra.applyBoardAssignment(DRIVER(teamA, person));
  await h.query(
    "UPDATE dispatch_team_drivers SET assignment_source = 'manual', manual_override_at = NULL WHERE id = $1",
    [placed.id]
  );

  const moved = await ra.applyBoardAssignment({ ...DRIVER(teamB, person), boardDispatcher: 'Steven' });
  assert.notEqual(moved.heldByOverride, true, 'the guarantee must not depend on the planner alone');
  const active = (await h.query('SELECT team_id FROM dispatch_team_drivers WHERE active')).rows;
  assert.deepEqual(active.map((r) => r.team_id), [teamB]);
});

test('a legacy row can be retired, a deliberate override cannot', async (t) => {
  if (skipWithoutPg(t)) return;
  const { h, ra, teamA, person } = await setup(t);

  const legacy = await ra.applyBoardAssignment(DRIVER(teamA, person));
  await h.query(
    "UPDATE dispatch_team_drivers SET assignment_source = 'manual', manual_override_at = NULL WHERE id = $1",
    [legacy.id]
  );
  assert.equal(await ra.retireBoardAssignment(legacy.id), true,
    'otherwise a driver stays on a team the board no longer agrees with for ever');

  const other = await ra.applyBoardAssignment({
    ...DRIVER(teamA, null), driverNormalizedName: 'MARIA GARCIA', driverName: 'MARIA GARCIA',
  });
  await ra.markManualOverride(other.id, 'admin:jane');
  assert.equal(await ra.retireBoardAssignment(other.id), false);
});

/*
 * EVERY MANUAL WRITE PATH STAMPS, or the timestamp is not a discriminator.
 *
 * Reconciliation tells a person's decision from an inherited row by
 * `manual_override_at`. That only holds if every path a person writes through
 * sets it. `setTeamDrivers` — the admin typing a whole team's roster through
 * PUT /api/raise/admin/teams/:id/drivers — relied on the column DEFAULT, which
 * gives `assignment_source = 'manual'` and no timestamp, so the next rebuild
 * would have read the administrator's own roster as legacy and reassigned it
 * from the Board with nothing to show the edit had been undone.
 */
test('a roster typed by an admin is stamped as their decision, in the INSERT', async (t) => {
  if (skipWithoutPg(t)) return;
  const { h, ra, teamA } = await setup(t);

  await ra.setTeamDrivers(teamA, [
    { driver_normalized_name: 'ANA LOPEZ', driver_name: 'Ana Lopez', driver_external_id: null },
  ], { overriddenBy: 'admin:jane' });

  const row = (await h.query(
    'SELECT assignment_source, manual_override_at, manual_override_by FROM dispatch_team_drivers WHERE team_id = $1',
    [teamA]
  )).rows[0];
  assert.equal(row.assignment_source, 'manual');
  assert.ok(row.manual_override_at, 'the stamp is what reconciliation reads; without it this row is legacy');
  assert.equal(row.manual_override_by, 'admin:jane', 'and it names who decided');
});

test('a roster typed by an admin is not retired when the Board stops naming them', async (t) => {
  if (skipWithoutPg(t)) return;
  const { h, ra, teamA } = await setup(t);

  await ra.setTeamDrivers(teamA, [
    { driver_normalized_name: 'JOHN SMITH', driver_name: 'JOHN SMITH', driver_external_id: null },
  ], { overriddenBy: 'admin:jane' });
  const typed = (await h.query(
    'SELECT id FROM dispatch_team_drivers WHERE team_id = $1', [teamA]
  )).rows[0].id;

  // Retiring is how a driver the Board no longer mentions leaves the roster. A
  // stamped row is somebody's decision and is refused — which is exactly what
  // the missing stamp would have cost: the administrator's roster would have
  // been swept away the first time the Board went quiet about that driver.
  assert.equal(await ra.retireBoardAssignment(typed), false,
    "the Board's silence does not undo a person's decision");

  const still = (await h.query(
    'SELECT team_id, active FROM dispatch_team_drivers WHERE id = $1', [typed]
  )).rows[0];
  assert.equal(still.team_id, teamA);
  assert.equal(still.active, true);
});
