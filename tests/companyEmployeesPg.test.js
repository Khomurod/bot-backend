'use strict';

/**
 * database/companyEmployees.js against PostgreSQL (migration 0084): a
 * suggestion never overwrites a person, the list never reads photo bytes, and
 * a photo goes with its employee. Requires TEST_DATABASE_URL. Made-up names.
 * See docs/architecture/employee-birthday-cards.md.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const layer = h.loadDataLayer(['companyEmployees', 'employeeBirthdays']);
  const a = await layer.employeeBirthdays.upsertEmployeeBirthday('TESTBEK', 'EXAMPLOV', '1990-10-26');
  const b = await layer.employeeBirthdays.upsertEmployeeBirthday('OZOD', 'EXAMPLOV', '1991-03-02');
  return { h, ...layer, a, b };
}

test('a typed account is confirmed; clearing it clears the match', { skip: skipWithoutPg() }, async (t) => {
  const { companyEmployees: store, a } = await setup(t);
  const saved = await store.updateCompanyEmployee(a.id, {
    americanName: 'Sample Person', telegramUsername: 'sample_person', telegramUserId: '9007199254740993',
  });
  assert.equal(saved.american_name, 'Sample Person');
  assert.equal(saved.telegram_match, 'confirmed');
  assert.equal(saved.telegram_user_id, '9007199254740993', 'a big id survives as text');

  const cleared = await store.updateCompanyEmployee(a.id, { americanName: 'Sample Person', telegramUsername: null, telegramUserId: null });
  assert.equal(cleared.telegram_match, null);
  assert.equal(await store.updateCompanyEmployee(999999, { americanName: 'x' }), null);
});

test('a suggestion fills an empty row or replaces a suggestion, never a confirmed account', { skip: skipWithoutPg() }, async (t) => {
  const { companyEmployees: store, a, b } = await setup(t);
  await store.updateCompanyEmployee(b.id, { americanName: 'Quinn', telegramUsername: 'quinn_typed', telegramUserId: null });

  const written = await store.applyTelegramSuggestions([
    { employeeId: a.id, telegramUserId: '111', username: 'Sample_P' },
    { employeeId: b.id, telegramUserId: '222', username: 'other' },
  ]);
  assert.equal(written, 1);
  let rows = await store.listCompanyEmployees();
  const rowA = rows.find((r) => r.id === a.id);
  const rowB = rows.find((r) => r.id === b.id);
  assert.deepEqual([rowA.telegram_user_id, rowA.telegram_username, rowA.telegram_match], ['111', 'sample_p', 'suggested']);
  assert.deepEqual([rowB.telegram_username, rowB.telegram_match], ['quinn_typed', 'confirmed']);

  assert.equal(await store.applyTelegramSuggestions([{ employeeId: a.id, telegramUserId: '333', username: null }]), 1);
  assert.equal((await store.confirmTelegramMatch(a.id)).telegram_match, 'confirmed');
  assert.equal(await store.confirmTelegramMatch(a.id), null, 'nothing left to confirm');
  assert.equal(await store.applyTelegramSuggestions([{ employeeId: a.id, telegramUserId: '444', username: null }]), 0);
  rows = await store.listCompanyEmployees();
  assert.equal(rows.find((r) => r.id === a.id).telegram_user_id, '333');
});

test('telegram_match takes only its two values', { skip: skipWithoutPg() }, async (t) => {
  const { h, a } = await setup(t);
  await assert.rejects(() => h.query("UPDATE employee_birthdays SET telegram_match = 'guessed' WHERE id = $1", [a.id]));
});

test('photos: stored, flagged on the list without their bytes, and gone with the employee', { skip: skipWithoutPg() }, async (t) => {
  const { h, companyEmployees: store, employeeBirthdays, a } = await setup(t);
  assert.equal(await store.getPhoto(a.id), null);
  await store.savePhoto(a.id, Buffer.from([1, 2, 3]));
  await store.savePhoto(a.id, Buffer.from([4, 5]));
  assert.deepEqual([...(await store.getPhoto(a.id))], [4, 5]);

  const listed = (await store.listCompanyEmployees()).find((r) => r.id === a.id);
  assert.equal(listed.has_photo, true);
  assert.equal('image' in listed, false);

  // The birthday pass reads employees with the new columns.
  const today = await employeeBirthdays.getEmployeesWithBirthdayOn(10, 26);
  assert.equal(today[0].id, a.id);
  assert.ok('american_name' in today[0]);

  await employeeBirthdays.deleteEmployeeBirthday(a.id);
  const left = await h.query('SELECT COUNT(*)::int AS n FROM employee_photos');
  assert.equal(left.rows[0].n, 0);
  assert.equal(await store.deletePhoto(a.id), false);
});

test('known Telegram accounts: bots left out, one row per account, newest name wins', { skip: skipWithoutPg() }, async (t) => {
  const { h, companyEmployees: store } = await setup(t);
  await h.query(`INSERT INTO bot_users (telegram_user_id, username, first_name, is_bot, last_interaction_at)
                 VALUES (10, 'old_name', 'Old', FALSE, NOW() - INTERVAL '2 days'),
                        (11, 'a_bot', 'Robot', TRUE, NOW())`);
  const g = await h.query(`INSERT INTO groups (telegram_group_id, group_name) VALUES (-100, 'Test group') RETURNING id`);
  await h.query(`INSERT INTO group_members (group_id, telegram_user_id, username, first_name, last_seen_at)
                 VALUES ($1, 10, 'new_name', 'New', NOW()), ($1, 12, NULL, 'Plain', NOW())`, [g.rows[0].id]);
  const accounts = await store.listKnownTelegramAccounts();
  assert.deepEqual(accounts.map((x) => [String(x.telegram_user_id), x.username, x.first_name]),
    [['10', 'new_name', 'New'], ['12', null, 'Plain']]);
});

test('a birthday claim is taken over only once it is older than the limit', { skip: skipWithoutPg() }, async (t) => {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { db } = h.loadDataLayer(['db']);
  assert.equal(await db.claimServiceRun('birthday', 'employee:2026-10-26:1'), true);
  assert.equal(await db.releaseStaleServiceRun('birthday', 'employee:2026-10-26:1', 10), false, 'a fresh claim is a pass still working');
  await h.query("UPDATE service_runs SET ran_at = ran_at - INTERVAL '11 minutes' WHERE run_key = 'employee:2026-10-26:1'");
  assert.equal(await db.releaseStaleServiceRun('birthday', 'employee:2026-10-26:1', 10), true);
  assert.equal(await db.claimServiceRun('birthday', 'employee:2026-10-26:1'), true);
});
