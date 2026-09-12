'use strict';

/**
 * Recording a Telegram account against a person, on a real PostgreSQL.
 *
 * THREE THINGS ONLY A REAL DATABASE PROVES:
 *   the migration carries across what an administrator already typed;
 *   ONE OPEN ROW PER ACCOUNT is a partial unique index, not a JavaScript check;
 *   the apply re-derives from the live room and refuses when it has changed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');
const { POOL_PATH, purgeDataLayer } = require('./helpers/purgeDataLayer');

const ALL_MIGRATIONS = allMigrationsSql();
const SERVICE_PATHS = [
  '../services/operations/corrections/actions', '../services/operations/corrections/telegramActions',
  '../services/operations/corrections/apply', '../services/operations/checks/telegramIdentity',
].map((p) => path.resolve(__dirname, `${p}.js`));

function bind(harness) {
  purgeDataLayer(SERVICE_PATHS);
  require.cache[POOL_PATH] = {
    id: POOL_PATH, filename: POOL_PATH, loaded: true,
    exports: { pool: harness.pool, query: harness.query, ping: async () => true },
  };
  try {
    const db = { pool: harness.pool, query: harness.query };
    const apply = require('../services/operations/corrections/apply');
    const people = require('../database/driverPeople');
    return {
      people,
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

async function seedDriver(h, {
  groupId, name = 'JOHN SMITH', telegramUserId = null, members = [],
}) {
  const [first, ...rest] = name.split(' ');
  await h.query(
    `INSERT INTO groups (id, telegram_group_id, group_name, group_type, active)
     VALUES ($1, $2, $3, 'driver', TRUE)`,
    [groupId, -800000 - groupId, `WENZE UNIT # ${groupId} ${name}`]
  );
  await h.query(
    `INSERT INTO driver_profiles (group_id, first_name, last_name, telegram_user_id)
     VALUES ($1, $2, $3, $4)`,
    [groupId, first, rest.join(' '), telegramUserId]
  );
  const p = await h.query(
    `INSERT INTO driver_people (display_name, normalized_key) VALUES ($1, $2) RETURNING id`,
    [name, name.toLowerCase().replace(/\s+/g, '')]
  );
  await h.query(
    `INSERT INTO driver_person_groups (person_id, group_id, started_at, association_source)
     VALUES ($1, $2, NOW(), 'manual')`,
    [p.rows[0].id, groupId]
  );
  for (const m of members) {
    await h.query(
      `INSERT INTO group_members (group_id, telegram_user_id, username, first_name, last_name)
       VALUES ($1, $2, $3, $4, $5)`,
      [groupId, m.id, m.username || null, m.first || null, m.last || null]
    );
  }
  return p.rows[0].id;
}

test('THE MIGRATION CARRIES ACROSS WHAT AN ADMINISTRATOR ALREADY TYPED', {
  skip: skipWithoutPg(),
}, async (t) => {
  // A `telegram_user_id` typed into a profile by a person is the strongest
  // evidence in the system — somebody looked and decided — so it seeds at 100.
  const h = await createPgHarness(t, { extraDdl: '' });
  await h.applySchemaSql();
  // Everything up to, but not including, 0049.
  await h.query(allMigrationsSql((n) => n < '0049'));
  const personId = await seedDriver(h, { groupId: 8001, telegramUserId: 777001 });

  await h.query(allMigrationsSql((n) => n.startsWith('0049')));
  const rows = await h.query(
    'SELECT person_id, telegram_user_id, link_source, confidence FROM driver_person_telegram_identities'
  );
  assert.equal(rows.rowCount, 1);
  assert.equal(Number(rows.rows[0].person_id), personId);
  assert.equal(String(rows.rows[0].telegram_user_id), '777001');
  assert.equal(rows.rows[0].link_source, 'profile_backfill');
  assert.equal(rows.rows[0].confidence, 100);
});

test('ONE OPEN ROW PER ACCOUNT — the index refuses the second', {
  skip: skipWithoutPg(),
}, async (t) => {
  const h = await setup(t);
  const { people } = bind(h);
  const a = await seedDriver(h, { groupId: 8002, name: 'ONE DRIVER' });
  const b = await seedDriver(h, { groupId: 8003, name: 'TWO DRIVER' });

  const first = await people.openTelegramIdentity({
    personId: a, telegramUserId: '777002', linkSource: 'manual', confidence: 100,
  });
  assert.ok(first);

  const second = await people.openTelegramIdentity({
    personId: b, telegramUserId: '777002', linkSource: 'manual', confidence: 100,
  });
  assert.equal(second, null, 'the guarantee working, not an error');

  // Closing it frees the account for its new owner, and leaves the trail.
  await people.closeTelegramIdentity({ telegramUserId: '777002', reason: 'left' });
  const moved = await people.openTelegramIdentity({
    personId: b, telegramUserId: '777002', linkSource: 'manual', confidence: 100,
  });
  assert.ok(moved, 'an account can move to a new owner');
  const all = await h.query(
    'SELECT COUNT(*)::int AS n FROM driver_person_telegram_identities WHERE telegram_user_id = 777002'
  );
  assert.equal(all.rows[0].n, 2, 'the closed row is kept — that trail is the point');
});

test('A PERSON MAY HOLD TWO ACCOUNTS — the constraint is on the account', {
  skip: skipWithoutPg(),
}, async (t) => {
  const h = await setup(t);
  const { people } = bind(h);
  const personId = await seedDriver(h, { groupId: 8004, name: 'TWO PHONES' });
  assert.ok(await people.openTelegramIdentity({ personId, telegramUserId: '777004', linkSource: 'manual' }));
  assert.ok(await people.openTelegramIdentity({ personId, telegramUserId: '777005', linkSource: 'manual' }));
});

test('the correction links, fills a BLANK profile column, and the revert undoes both', {
  skip: skipWithoutPg(),
}, async (t) => {
  const h = await setup(t);
  const { applyCorrection, revertCorrection } = bind(h);
  const personId = await seedDriver(h, {
    groupId: 8005, name: 'JOHN SMITH',
    members: [{ id: 777006, first: 'JOHN', last: 'SMITH' }],
  });

  const correction = await applyCorrection({
    actionKey: 'identity.link_telegram',
    payload: { groupId: 8005, personId, telegramUserId: '777006' },
    admin: ADMIN, reason: 'test',
  });
  let linked = await h.query(
    'SELECT person_id, confidence FROM driver_person_telegram_identities WHERE ended_at IS NULL'
  );
  assert.equal(Number(linked.rows[0].person_id), personId);
  assert.equal(linked.rows[0].confidence, 90);
  let profile = await h.query('SELECT telegram_user_id FROM driver_profiles WHERE group_id = 8005');
  assert.equal(String(profile.rows[0].telegram_user_id), '777006');

  await revertCorrection({ correctionId: correction.id, admin: ADMIN, reason: 'undo' });
  linked = await h.query('SELECT 1 FROM driver_person_telegram_identities WHERE ended_at IS NULL');
  assert.equal(linked.rowCount, 0);
  profile = await h.query('SELECT telegram_user_id FROM driver_profiles WHERE group_id = 8005');
  assert.equal(profile.rows[0].telegram_user_id, null, 'the column it filled is cleared');
});

test("IT NEVER OVERWRITES AN ADMINISTRATOR'S CHOICE", { skip: skipWithoutPg() }, async (t) => {
  // Somebody typed an account into the profile. They decided something.
  const h = await setup(t);
  const { applyCorrection, revertCorrection } = bind(h);
  const personId = await seedDriver(h, {
    groupId: 8006, name: 'JOHN SMITH', telegramUserId: 999999,
    members: [{ id: 777007, first: 'JOHN', last: 'SMITH' }],
  });

  const correction = await applyCorrection({
    actionKey: 'identity.link_telegram',
    payload: { groupId: 8006, personId, telegramUserId: '777007' },
    admin: ADMIN, reason: 'test',
  });
  let profile = await h.query('SELECT telegram_user_id FROM driver_profiles WHERE group_id = 8006');
  assert.equal(String(profile.rows[0].telegram_user_id), '999999', "the person's own value stands");

  // And the revert does not clear a column this correction did not set.
  await revertCorrection({ correctionId: correction.id, admin: ADMIN, reason: 'undo' });
  profile = await h.query('SELECT telegram_user_id FROM driver_profiles WHERE group_id = 8006');
  assert.equal(String(profile.rows[0].telegram_user_id), '999999');
});

test('THE APPLY RE-READS THE ROOM — somebody joining refuses it', {
  skip: skipWithoutPg(),
}, async (t) => {
  const h = await setup(t);
  const { applyCorrection } = bind(h);
  const personId = await seedDriver(h, {
    groupId: 8007, name: 'JOHN SMITH',
    members: [{ id: 777008, first: 'JOHN', last: 'SMITH' }],
  });
  // Between the sweep and the apply, a second person joins the chat.
  await h.query(
    `INSERT INTO group_members (group_id, telegram_user_id, first_name, last_name)
     VALUES (8007, 777009, 'ANN', 'LEE')`
  );

  await assert.rejects(
    () => applyCorrection({
      actionKey: 'identity.link_telegram',
      payload: { groupId: 8007, personId, telegramUserId: '777008' },
      admin: ADMIN, reason: 'test',
    }),
    /no longer resolves to one account/
  );
  const linked = await h.query('SELECT 1 FROM driver_person_telegram_identities WHERE ended_at IS NULL');
  assert.equal(linked.rowCount, 0, 'nothing was written');
});

test('an account taken between the sweep and the apply is refused', {
  skip: skipWithoutPg(),
}, async (t) => {
  const h = await setup(t);
  const { applyCorrection, people } = bind(h);
  const mine = await seedDriver(h, {
    groupId: 8008, name: 'JOHN SMITH',
    members: [{ id: 777010, first: 'JOHN', last: 'SMITH' }],
  });
  const other = await seedDriver(h, { groupId: 8009, name: 'OTHER PERSON' });
  await people.openTelegramIdentity({ personId: other, telegramUserId: '777010', linkSource: 'manual' });

  await assert.rejects(
    () => applyCorrection({
      actionKey: 'identity.link_telegram',
      payload: { groupId: 8008, personId: mine, telegramUserId: '777010' },
      admin: ADMIN, reason: 'test',
    }),
    // Already-linked accounts are filtered out of the candidate list, so the
    // rule stops seeing a candidate at all before the index is ever reached.
    /no longer resolves to one account/
  );
});

test('the lookup reads the identity table first, and falls back to the profile', {
  skip: skipWithoutPg(),
}, async (t) => {
  const h = await setup(t);
  const { people } = bind(h);
  // A chat carrying the account on its profile, and nothing in the new table.
  const viaProfile = await seedDriver(h, { groupId: 8010, name: 'PROFILE ONLY', telegramUserId: 777011 });
  assert.equal(await people.findPersonByTelegramUserId('777011'), viaProfile);

  // A person-level link for an account NO profile carries — the case that only
  // works because the identity table is consulted first.
  const viaIdentity = await seedDriver(h, { groupId: 8011, name: 'LINKED ONLY' });
  await people.openTelegramIdentity({ personId: viaIdentity, telegramUserId: '777012', linkSource: 'manual' });
  assert.equal(await people.findPersonByTelegramUserId('777012'), viaIdentity);
});

test('A MISSING TABLE INSIDE A TRANSACTION DOES NOT POISON IT', {
  skip: skipWithoutPg(),
}, async (t) => {
  // In PostgreSQL a failed statement aborts the whole transaction. A bare
  // try/catch around the identity read would swallow the error and then every
  // later query on the same client fails with "current transaction is aborted"
  // — turning a table missing mid-deploy into a broken correction. The
  // savepoint undoes only the failed read.
  const h = await setup(t);
  const { people } = bind(h);
  const personId = await seedDriver(h, { groupId: 8013, name: 'MID DEPLOY', telegramUserId: 777014 });
  await h.query('DROP TABLE driver_person_telegram_identities');

  const client = await h.connect();
  try {
    await client.query('BEGIN');
    // Falls back to the profile column rather than throwing…
    assert.equal(await people.findPersonByTelegramUserId('777014', {}, client), personId);
    // …and the transaction is still usable afterwards, which is the point.
    const after = await client.query('SELECT 1 AS ok');
    assert.equal(after.rows[0].ok, 1);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
});

test('a real read failure is NOT swallowed', { skip: skipWithoutPg() }, async (t) => {
  // Only "no such table" falls through. Hiding anything else would answer
  // "no such person" about a database we simply could not read.
  const h = await setup(t);
  const { people } = bind(h);
  const client = await h.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL statement_timeout = 1');
    await client.query("SELECT pg_sleep(0.2)").catch(() => {});
    await client.query('ROLLBACK');
    // A syntactically impossible id reaches the driver as a cast error, which
    // is a real failure and must surface.
    await assert.rejects(() => people.findPersonByTelegramUserId('not-a-number'));
  } finally {
    client.release();
  }
});

test('the migration is idempotent and does not duplicate the backfill', {
  skip: skipWithoutPg(),
}, async (t) => {
  const h = await setup(t);
  await seedDriver(h, { groupId: 8012, name: 'RERUN DRIVER', telegramUserId: 777013 });
  const sql = allMigrationsSql((n) => n.startsWith('0049'));
  await h.query(sql);
  await h.query(sql);
  const rows = await h.query(
    'SELECT COUNT(*)::int AS n FROM driver_person_telegram_identities WHERE telegram_user_id = 777013'
  );
  assert.equal(rows.rows[0].n, 1);
});
