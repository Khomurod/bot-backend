'use strict';

/**
 * The retired-feature cleanup action's safety properties (unit level).
 *
 * This is the one code path in the application that drops tables, so what it
 * REFUSES matters more than what it does. These tests pin the refusals:
 *   - a table name from a request can never reach SQL;
 *   - the allow-list contains no surviving table;
 *   - the company-wide permission keys are not treated as leftovers.
 *
 * The behaviour against a real database (dropping in dependency order without
 * CASCADE, and reporting what it could not drop) is in
 * tests/retiredLeftoversPg.test.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const leftovers = require('../database/retiredLeftovers');

// Tables that belong to features that are still running. If any of these ever
// appears in the allow-list, the cleanup action becomes a way to delete live
// data, so this is the single most important assertion in the file.
const SURVIVING_TABLES = [
  'groups', 'drivers', 'driver_profiles', 'questions', 'responses', 'broadcasts',
  'scheduled_messages', 'admins', 'roles', 'permissions', 'role_permissions',
  'admin_user_roles', 'admin_audit_log', 'facebook_leads', 'recruiters',
  'ringcentral_calls', 'route_assignments', 'home_time_settings',
  'mileage_bonus_notifications', 'driver_road_history', 'raise_rounds',
  'fuel_monitor_inbox', 'dispatch_eta_updates', 'safety_event_video_jobs',
  'bol_pod_forwarding_settings', 'database_transfer_usage', 'schema_migrations',
  'bot_sent_messages', 'employee_birthdays', 'dispatch_teams', 'bitrix_settings',
];

test('the allow-list contains no table belonging to a surviving feature', () => {
  const allowed = new Set(leftovers.tablesForGroups(leftovers.GROUP_KEYS));
  for (const table of SURVIVING_TABLES) {
    assert.equal(allowed.has(table), false, `${table} must never be droppable`);
  }
});

test('every allow-listed table name is a plain identifier', () => {
  // Names are interpolated into DROP TABLE "…", so a name containing a quote,
  // a semicolon or whitespace would be an injection vector even though it
  // cannot come from a request. Belt and braces.
  for (const table of leftovers.tablesForGroups(leftovers.GROUP_KEYS)) {
    assert.match(table, /^[a-z][a-z0-9_]*$/, `${table} is not a plain identifier`);
  }
});

test('an unsafe table name is refused at the interpolation site itself', () => {
  // The lists are frozen and the route validates group keys, so this can only
  // fire on a future edit to database/retiredLeftovers.js — which is exactly
  // when a DROP TABLE built by string interpolation needs a second opinion.
  for (const bad of ['Trailers', 'trailer;DROP', 'public.trailers', 'trailer"x',
    '', '1trailer', 'trailer table', 'trailer-x']) {
    assert.throws(() => leftovers.assertSafeIdentifier(bad), /unsafe table name/,
      `${JSON.stringify(bad)} must be refused`);
  }
  for (const good of leftovers.tablesForGroups(leftovers.GROUP_KEYS)) {
    assert.equal(leftovers.assertSafeIdentifier(good), good);
  }
});

test('an unknown group key is rejected, not silently ignored', () => {
  assert.equal(leftovers.isKnownGroup('trailer'), true);
  assert.equal(leftovers.isKnownGroup('groups'), false);
  assert.throws(() => leftovers.tablesForGroups(['groups']), (e) => e.status === 400);
  assert.throws(() => leftovers.tablesForGroups(['trailer', 'admins']), (e) => e.status === 400);
});

test('a table name cannot be passed in — only group keys are accepted', () => {
  // The API takes `groups`, and every group key maps to a fixed table list.
  // Passing a table name where a group is expected must fail closed.
  for (const attempt of ['drivers', 'trailers', 'public.groups', 'groups; DROP TABLE admins']) {
    assert.throws(
      () => leftovers.tablesForGroups([attempt]),
      (e) => e.status === 400,
      `"${attempt}" must be refused as a group key`,
    );
  }
});

test('the four company-wide permission keys are not retired', () => {
  const prefixes = leftovers.RETIRED_PERMISSION_PREFIXES;
  const matches = (key) => prefixes.some((p) => key.startsWith(p));
  assert.equal(matches('admin.full_access'), false);
  assert.equal(matches('users.manage'), false);
  assert.equal(matches('roles.manage'), false);
  // …and the trailer keys are.
  assert.equal(matches('trailers.view'), true);
  assert.equal(matches('trailer_payments.reverse'), true);
});

test('super_admin is not a retired role key', () => {
  assert.equal(leftovers.RETIRED_ROLE_KEYS.includes('super_admin'), false);
  assert.deepEqual([...leftovers.RETIRED_ROLE_KEYS].sort(), [
    'trailer_accounting', 'trailer_employee', 'trailer_manager', 'trailer_viewer',
  ]);
});

test('each group declares a label, a note and a non-empty table list', () => {
  for (const key of leftovers.GROUP_KEYS) {
    const group = leftovers.RETIRED_GROUPS[key];
    assert.ok(group.label, `${key} needs a label`);
    assert.ok(group.note, `${key} needs a note explaining what is lost`);
    assert.ok(group.tables.length > 0, `${key} needs tables`);
  }
});

test('the confirmation phrase is not something typed by reflex', () => {
  const { DROP_CONFIRMATION_PHRASE } = require('../server/routes/settings/retiredLeftoversRoutes');
  assert.ok(DROP_CONFIRMATION_PHRASE.length > 10);
  for (const reflex of ['yes', 'ok', 'confirm', 'delete', 'y']) {
    assert.notEqual(DROP_CONFIRMATION_PHRASE.toLowerCase(), reflex);
  }
});

test('the boot baseline never recreates a table this tool can DROP', () => {
  // The bug this guards, in full: schema.sql is applied VERBATIM on every boot.
  // Five tables in the "earlier retired features" group were still created by
  // database/baseline/004_employee_engagement.sql and 015_driver_location.sql,
  // so an operator who typed the confirmation phrase and dropped them destroyed
  // the rows for good and then watched the empty tables reappear at the next
  // restart — with the inventory reporting them as leftovers all over again. A
  // destructive action that does not stay done is worse than no action.
  //
  // The fix was to stop CREATEing them (not to drop them automatically, which
  // would destroy data without asking). This test is the durable half: adding a
  // table to a droppable group while a baseline segment still creates it now
  // fails here instead of in production.
  const fs = require('node:fs');
  const path = require('node:path');
  const schema = fs.readFileSync(
    path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8',
  );

  const offenders = [];
  for (const key of leftovers.GROUP_KEYS) {
    for (const table of leftovers.RETIRED_GROUPS[key].tables) {
      const creates = new RegExp(
        `CREATE\\s+TABLE\\s+(IF\\s+NOT\\s+EXISTS\\s+)?(public\\.)?${table}\\b`, 'i',
      );
      if (creates.test(schema)) offenders.push(`${key}/${table}`);
    }
  }
  assert.deepEqual(
    offenders, [],
    'these tables are droppable AND recreated on boot — remove the CREATE from '
    + 'database/baseline/*.sql (and run npm run build:schema), or take the table '
    + 'out of the droppable group',
  );
});

test('the sentinel above can actually fail (it is not matching nothing)', () => {
  // A regex typo would make the guard silently vacuous, so prove the same
  // matcher fires on a table the baseline really does create.
  const fs = require('node:fs');
  const path = require('node:path');
  const schema = fs.readFileSync(
    path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8',
  );
  const surviving = /CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?(public\.)?groups\b/i;
  assert.ok(surviving.test(schema), 'the baseline does create `groups`');
});
