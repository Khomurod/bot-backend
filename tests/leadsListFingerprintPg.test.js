/**
 * The admin Leads page's list and its fingerprint, against a REAL PostgreSQL.
 *
 * GET /api/leads answers 304, and skips reading the list, whenever this
 * fingerprint matches the one the browser holds. So it must move whenever
 * anything the page shows would: a Bitrix status, an edited field, a new lead,
 * a lead leaving the page. One it missed would leave the page showing a stale
 * list, silently, until something else changed. And it must NOT move when
 * nothing shown did, or every poll pays for the list again. Only the real
 * md5/json_agg statement can prove either.
 *
 * Needs TEST_DATABASE_URL and SKIPS without it. A skipped test is not a
 * passing test (CLAUDE.md); CI fails on any skip.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();

/** Everything the page renders, and nothing else, in the order the list sends it. */
const PAGE_COLUMNS = [
  'id', 'source', 'full_name', 'email', 'phone', 'job_title', 'message', 'bitrix_status', 'created_at',
];

async function setup(t) {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { leads } = harness.loadDataLayer(['leads']);
  return { harness, leads };
}

/**
 * A made-up lead with a chosen created_at, so order and ties are decided here
 * rather than raced. Seeded in 2020, so a lead written with NOW() is newer.
 */
async function addLead(harness, { source = 'facebook', externalId, fullName, createdAt }) {
  const res = await harness.query(
    `INSERT INTO leads (source, external_id, full_name, phone, job_title, raw, created_at)
     VALUES ($1, $2, $3, '+15550100000', 'CDL-A Driver', '{"made_up": true}'::jsonb, $4)
     RETURNING id`,
    [source, externalId, fullName, createdAt]
  );
  return res.rows[0].id;
}

test('the list sends only what the page renders, newest first, a tie broken by id', { skip: skipWithoutPg() }, async (t) => {
  const { harness, leads } = await setup(t);
  const ada = await addLead(harness, { externalId: 'lg-a', fullName: 'Ada Example', createdAt: '2020-01-01 09:00:00' });
  const ben = await addLead(harness, { externalId: 'lg-b', fullName: 'Ben Example', createdAt: '2020-01-02 09:00:00' });
  const cy = await addLead(harness, { externalId: 'lg-c', fullName: 'Cy Example', createdAt: '2020-01-02 09:00:00' });
  const dee = await addLead(harness, {
    source: 'indeed', externalId: 'gm-d', fullName: 'Dee Example', createdAt: '2020-01-03 09:00:00',
  });

  const listed = async (limit, source) => (await leads.listLeadsWithFingerprint(limit, source)).leads;
  const rows = await listed(100, null);

  assert.deepEqual(rows.map((row) => row.id), [dee, cy, ben, ada], 'Ben and Cy share an instant: the higher id first');
  for (const row of rows) assert.deepEqual(Object.keys(row), PAGE_COLUMNS);
  assert.deepEqual((await listed(100, 'indeed')).map((row) => row.id), [dee]);
  assert.deepEqual((await listed(2, 'facebook')).map((row) => row.id), [cy, ben]);
});

test('a list comes with the fingerprint of exactly that list', { skip: skipWithoutPg() }, async (t) => {
  const { harness, leads } = await setup(t);
  const same = async (limit, source, what) => {
    const { leads: rows, fingerprint } = await leads.listLeadsWithFingerprint(limit, source);
    assert.equal(fingerprint, await leads.getLeadListFingerprint(limit, source), what);
    return rows;
  };

  assert.deepEqual(await same(100, null, 'an empty page'), [], 'an empty page sends no lead');
  await addLead(harness, { externalId: 'lg-a', fullName: 'Ada Example', createdAt: '2020-01-01 09:00:00' });
  await addLead(harness, { externalId: 'lg-b', fullName: 'Ben Example', createdAt: '2020-01-02 09:00:00' });
  await addLead(harness, {
    source: 'indeed', externalId: 'gm-c', fullName: 'Cy Example', createdAt: '2020-01-03 09:00:00',
  });
  assert.equal((await same(100, null, 'the full page')).length, 3);
  assert.equal((await same(1, null, 'a one-lead page')).length, 1);
  assert.equal((await same(100, 'facebook', 'a filtered page')).length, 2);
  assert.deepEqual(await same(100, 'nowhere', 'a filter nothing matches'), []);
});

test('the fingerprint is one md5, and holds while nothing shown changes', { skip: skipWithoutPg() }, async (t) => {
  const { harness, leads } = await setup(t);

  const empty = await leads.getLeadListFingerprint(100, null);
  assert.match(empty, /^[0-9a-f]{32}$/);
  assert.equal(await leads.getLeadListFingerprint(100, null), empty, 'an empty page is a stable page too');

  const id = await addLead(harness, { externalId: 'lg-a', fullName: 'Ada Example', createdAt: '2020-01-01 09:00:00' });
  const fingerprint = await leads.getLeadListFingerprint(100, null);
  assert.notEqual(fingerprint, empty);
  assert.equal(await leads.getLeadListFingerprint(100, null), fingerprint);

  // Columns the page never shows leave the list as it was, so a 304 is right.
  await harness.query(
    `UPDATE leads SET raw = '{"edited": true}'::jsonb, bitrix_id = 'B-9', external_id = 'lg-z',
            sms_from_number = '+15550100009'
      WHERE id = $1`,
    [id]
  );
  assert.equal(await leads.getLeadListFingerprint(100, null), fingerprint);
});

test('it moves when the Bitrix status or any shown field changes', { skip: skipWithoutPg() }, async (t) => {
  const { harness, leads } = await setup(t);
  const id = await addLead(harness, { externalId: 'lg-a', fullName: 'Ada Example', createdAt: '2020-01-01 09:00:00' });
  let fingerprint = await leads.getLeadListFingerprint(100, null);
  const assertMoved = async (what) => {
    const next = await leads.getLeadListFingerprint(100, null);
    assert.notEqual(next, fingerprint, what);
    fingerprint = next;
  };

  await leads.updateLeadBitrixResult(id, { bitrixId: 'B-1', status: 'created' });
  await assertMoved('bitrix_status pending → created');

  for (const [column, value] of [
    ['full_name', 'Ada Exampel'], ['email', 'ada@example.test'], ['phone', '+15550100003'],
    ['job_title', 'Owner-Operator'], ['message', 'Call after five'], ['source', 'indeed'],
    ['created_at', '2020-01-05 09:00:00'],
  ]) {
    await harness.query(`UPDATE leads SET ${column} = $2 WHERE id = $1`, [id, value]);
    await assertMoved(column);
  }
});

test('it moves when a lead arrives or leaves, over the same filter and limit as the list', { skip: skipWithoutPg() }, async (t) => {
  const { harness, leads } = await setup(t);
  const ada = await addLead(harness, { externalId: 'lg-a', fullName: 'Ada Example', createdAt: '2020-01-01 09:00:00' });
  await addLead(harness, { externalId: 'lg-b', fullName: 'Ben Example', createdAt: '2020-01-02 09:00:00' });
  await addLead(harness, { externalId: 'lg-c', fullName: 'Cy Example', createdAt: '2020-01-03 09:00:00' });

  // LIMIT: Ada is below a two-lead page, so her change is not on it.
  const topTwo = await leads.getLeadListFingerprint(2, null);
  const everyone = await leads.getLeadListFingerprint(100, null);
  await leads.updateLeadBitrixResult(ada, { status: 'failed' });
  assert.equal(await leads.getLeadListFingerprint(2, null), topTwo, 'not on the two-lead page');
  assert.notEqual(await leads.getLeadListFingerprint(100, null), everyone, 'on the full page');

  // WHERE: an Indeed lead is not on the Facebook page, but it tops the
  // two-lead page and pushes Ben off it.
  const facebookPage = await leads.getLeadListFingerprint(100, 'facebook');
  await leads.createLeadIfNew({ source: 'indeed', externalId: 'gm-d', fullName: 'Dee Example' });
  assert.equal(await leads.getLeadListFingerprint(100, 'facebook'), facebookPage);
  assert.notEqual(await leads.getLeadListFingerprint(2, null), topTwo, 'a new lead, and one off the page');

  // A new Facebook lead is on the Facebook page; when it goes, the page is
  // what it was, and so is its fingerprint.
  const eve = await leads.createLeadIfNew({ source: 'facebook', externalId: 'lg-e', fullName: 'Eve Example' });
  assert.notEqual(await leads.getLeadListFingerprint(100, 'facebook'), facebookPage);
  await harness.query('DELETE FROM leads WHERE id = $1', [eve.id]);
  assert.equal(await leads.getLeadListFingerprint(100, 'facebook'), facebookPage);
});
