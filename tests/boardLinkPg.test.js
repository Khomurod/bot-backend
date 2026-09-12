'use strict';

/**
 * Linking a Board row to a person, against a real PostgreSQL.
 *
 * Three behaviours here exist only in SQL and under lock, so no stub can prove
 * them: the apply RE-RUNS the decision instead of trusting the sweep's payload,
 * it refuses when the answer has changed to a different person, and the revert
 * declines to touch a link somebody has since changed by hand.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');
const { POOL_PATH, purgeDataLayer } = require('./helpers/purgeDataLayer');

const ALL_MIGRATIONS = allMigrationsSql();
const SERVICE_PATHS = [
  '../services/operations/consistencyService', '../services/operations/corrections/actions',
  '../services/operations/corrections/boardActions', '../services/operations/corrections/apply',
  '../services/operations/corrections/autoApply', '../services/operations/checks/boardLink',
].map((p) => path.resolve(__dirname, `${p}.js`));

function bind(harness) {
  purgeDataLayer(SERVICE_PATHS);
  require.cache[POOL_PATH] = {
    id: POOL_PATH, filename: POOL_PATH, loaded: true,
    exports: { pool: harness.pool, query: harness.query, ping: async () => true },
  };
  try {
    const db = { pool: harness.pool, query: harness.query };
    const store = require('../database/operationalFindings');
    const apply = require('../services/operations/corrections/apply');
    const { runConsistencySweep } = require('../services/operations/consistencyService');
    return {
      store,
      sweep: () => runConsistencySweep({ db, store }),
      applyCorrection: (a) => apply.applyCorrection({ ...a, db }),
      revertCorrection: (a) => apply.revertCorrection({ ...a, db }),
    };
  } finally {
    delete require.cache[POOL_PATH];
    purgeDataLayer(SERVICE_PATHS);
  }
}

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  await h.query("INSERT INTO admins (id, username, password_hash) VALUES (1,'admin','x') ON CONFLICT DO NOTHING");
  return h;
}

const ADMIN = { id: 1, username: 'admin', roleKeys: ['super_admin'], ip: null };

async function seedPerson(h, { name, unit = null, fleetType = 'company', seat = 1 }) {
  const p = await h.query(
    `INSERT INTO driver_people (display_name, normalized_key) VALUES ($1, $2) RETURNING id`,
    [name, name.toLowerCase().replace(/\s+/g, '')]
  );
  const personId = p.rows[0].id;
  if (unit) {
    await h.query(
      `INSERT INTO driver_units (person_id, unit_number, fleet_type, seat, source)
       VALUES ($1, $2, $3, $4, 'manual')`,
      [personId, unit, fleetType, seat]
    );
  }
  return personId;
}

async function seedBoardRow(h, over = {}) {
  const row = {
    row_key: '001|JOHNSMITH', driver_name_raw: 'JOHN SMITH (COMPANY DRIVER)',
    driver_name_clean: 'JOHN SMITH', fleet_type: 'company',
    truck_norm: '001', truck_digits: '1', present: true, ...over,
  };
  const res = await h.query(
    `INSERT INTO dispatch_board_rows
       (row_key, driver_name_raw, driver_name_clean, fleet_type, truck_norm, truck_digits, present)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [row.row_key, row.driver_name_raw, row.driver_name_clean, row.fleet_type,
      row.truck_norm, row.truck_digits, row.present]
  );
  return res.rows[0];
}

test('the sweep files the link, the correction writes it, and the revert clears it', {
  skip: skipWithoutPg(),
}, async (t) => {
  const h = await setup(t);
  const { sweep, applyCorrection, revertCorrection, store } = bind(h);

  const personId = await seedPerson(h, { name: 'JOHN SMITH', unit: '001' });
  await seedBoardRow(h);

  await sweep();
  const [finding] = await store.listFindings({ status: 'open', checkKey: 'board.person_link' });
  assert.ok(finding, 'the sweep filed the link');
  assert.equal(finding.tier, 'auto');
  assert.equal(finding.proposedChange.personId, personId);

  const correction = await applyCorrection({
    actionKey: 'board.link_person',
    payload: { rowKey: '001|JOHNSMITH', personId, linkSource: 'board' },
    finding, admin: ADMIN, reason: 'test',
  });
  let row = await h.query('SELECT person_id, link_source, link_confidence FROM dispatch_board_rows WHERE row_key = $1', ['001|JOHNSMITH']);
  assert.equal(row.rows[0].person_id, personId);
  assert.equal(row.rows[0].link_source, 'board');
  assert.equal(row.rows[0].link_confidence, 95);

  await revertCorrection({ correctionId: correction.id, admin: ADMIN, reason: 'undo' });
  row = await h.query('SELECT person_id, link_source FROM dispatch_board_rows WHERE row_key = $1', ['001|JOHNSMITH']);
  assert.equal(row.rows[0].person_id, null);
  assert.equal(row.rows[0].link_source, null);
});

test('THE APPLY RE-RUNS THE DECISION — a person moved out of the truck refuses it', {
  skip: skipWithoutPg(),
}, async (t) => {
  const h = await setup(t);
  const { applyCorrection } = bind(h);
  const personId = await seedPerson(h, { name: 'JOHN SMITH', unit: '001' });
  await seedBoardRow(h);

  // Between the sweep and the apply, the truck assignment ends. The payload
  // still says person 5; the live rows no longer do.
  await h.query('UPDATE driver_units SET ended_at = NOW() WHERE person_id = $1', [personId]);

  await assert.rejects(
    () => applyCorrection({
      actionKey: 'board.link_person',
      payload: { rowKey: '001|JOHNSMITH', personId },
      admin: ADMIN, reason: 'test',
    }),
    /no longer resolves to one person/
  );
  const row = await h.query('SELECT person_id FROM dispatch_board_rows WHERE row_key = $1', ['001|JOHNSMITH']);
  assert.equal(row.rows[0].person_id, null, 'nothing was written');
});

test('STILL LINKABLE IS NOT ENOUGH — linkable to somebody ELSE is refused', {
  skip: skipWithoutPg(),
}, async (t) => {
  const h = await setup(t);
  const { applyCorrection } = bind(h);
  const john = await seedPerson(h, { name: 'JOHN SMITH' });
  await seedBoardRow(h);
  // The truck now belongs to a different person whose name also agrees.
  await seedPerson(h, { name: 'JOHN SMITH', unit: '001' });

  await assert.rejects(
    () => applyCorrection({
      actionKey: 'board.link_person',
      payload: { rowKey: '001|JOHNSMITH', personId: john },
      admin: ADMIN, reason: 'test',
    }),
    /now resolves to person/
  );
});

test('a row somebody linked first is not linked twice', { skip: skipWithoutPg() }, async (t) => {
  const h = await setup(t);
  const { applyCorrection } = bind(h);
  const personId = await seedPerson(h, { name: 'JOHN SMITH', unit: '001' });
  await seedBoardRow(h);
  await h.query('UPDATE dispatch_board_rows SET person_id = $1, link_source = $2 WHERE row_key = $3',
    [personId, 'manual', '001|JOHNSMITH']);

  await assert.rejects(
    () => applyCorrection({
      actionKey: 'board.link_person',
      payload: { rowKey: '001|JOHNSMITH', personId },
      admin: ADMIN, reason: 'test',
    }),
    /already linked/
  );
  const row = await h.query("SELECT link_source FROM dispatch_board_rows WHERE row_key = $1", ['001|JOHNSMITH']);
  assert.equal(row.rows[0].link_source, 'manual', "the person's own link survived");
});

test('a row that left the board refuses rather than linking history', { skip: skipWithoutPg() }, async (t) => {
  const h = await setup(t);
  const { applyCorrection } = bind(h);
  const personId = await seedPerson(h, { name: 'JOHN SMITH', unit: '001' });
  await seedBoardRow(h, { present: false });

  await assert.rejects(
    () => applyCorrection({
      actionKey: 'board.link_person',
      payload: { rowKey: '001|JOHNSMITH', personId },
      admin: ADMIN, reason: 'test',
    }),
    /no longer on the board/
  );
});

test('THE REVERT LEAVES A LINK SOMEBODY HAS SINCE CHANGED BY HAND', {
  skip: skipWithoutPg(),
}, async (t) => {
  const h = await setup(t);
  const { applyCorrection, revertCorrection } = bind(h);
  const personId = await seedPerson(h, { name: 'JOHN SMITH', unit: '001' });
  const other = await seedPerson(h, { name: 'MARIA GARCIA' });
  await seedBoardRow(h);

  const correction = await applyCorrection({
    actionKey: 'board.link_person',
    payload: { rowKey: '001|JOHNSMITH', personId },
    admin: ADMIN, reason: 'test',
  });
  // An administrator repoints the row afterwards. That is their decision.
  await h.query('UPDATE dispatch_board_rows SET person_id = $1 WHERE row_key = $2', [other, '001|JOHNSMITH']);

  await assert.rejects(
    () => revertCorrection({ correctionId: correction.id, admin: ADMIN, reason: 'undo' }),
    /no longer linked to person/
  );
  const row = await h.query('SELECT person_id FROM dispatch_board_rows WHERE row_key = $1', ['001|JOHNSMITH']);
  assert.equal(row.rows[0].person_id, other, "the administrator's link survived the revert");
});

test('a disagreement is filed as a warning and nothing is proposed', {
  skip: skipWithoutPg(),
}, async (t) => {
  const h = await setup(t);
  const { sweep, store } = bind(h);
  await seedPerson(h, { name: 'MARIA GARCIA', unit: '001' });
  await seedBoardRow(h);

  await sweep();
  const [finding] = await store.listFindings({ status: 'open', checkKey: 'board.person_link_conflict' });
  assert.ok(finding);
  assert.equal(finding.tier, 'warning');
  assert.equal(finding.proposedChange, null);
  const links = await h.query('SELECT person_id FROM dispatch_board_rows');
  assert.equal(links.rows[0].person_id, null, 'a disagreement never links');
});
