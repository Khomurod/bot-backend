'use strict';

/**
 * THE COLUMNS THE CHECKS DEPEND ON ARE ACTUALLY SELECTED.
 *
 * This file exists because the same defect has now happened twice, and both
 * times it was invisible: a check reads `row.some_column`, the snapshot's
 * SELECT does not list it, the value is `undefined`, and the check quietly
 * takes its fallback branch for ever. Nothing throws. Nothing is logged. The
 * sweep reports a healthy fleet.
 *
 *   `driver_profiles.driver_type` was missing, so every fleet-aware check fell
 *   back to reading the fleet out of the chat TITLE — making the rule A3b
 *   shipped ("the stored column wins, the title is the fallback when it is
 *   NULL") inert from the day it merged.
 *
 *   `driver_units.fleet_type` and `seat` were missing, so Company 001 and
 *   Lease 001 looked like one truck to the very checks migration 0047 was
 *   written to fix.
 *
 * A string test on a SQL literal is blunt, and it is the only thing that
 * catches this class without a database. `tests/*Pg.test.js` prove the queries
 * RUN; nothing there proves they select enough.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'operations', 'snapshot', 'loaders.js'), 'utf8'
);

/**
 * The SELECT list of the query that reads one table.
 *
 * WALKS BACK FROM THE `FROM`, not forward from a `SELECT`. A non-greedy match
 * starting at the first SELECT in the file spans every query between it and
 * the table — so the helper "found" columns that belonged to a different
 * query, and the first version of this file passed even with the column it was
 * written to guard deleted. A test that cannot fail is worse than no test.
 */
function selectFor(table) {
  const from = SOURCE.indexOf(`FROM ${table}`);
  assert.ok(from > 0, `no query in loaders.js reads ${table}`);
  const select = SOURCE.lastIndexOf('SELECT', from);
  assert.ok(select > 0 && select < from, `no SELECT precedes FROM ${table}`);
  return SOURCE.slice(select, from);
}

test('the profiles snapshot carries driver_type — the fleet rule reads it', () => {
  // Without this the stored driver type never reaches a check, and every one
  // of them silently decides the fleet from the chat title instead.
  assert.match(selectFor('driver_profiles'), /\bdriver_type\b/);
});

test('the profiles snapshot still carries what the older checks read', () => {
  const select = selectFor('driver_profiles');
  for (const column of ['group_id', 'unit_number', 'status', 'telegram_user_id']) {
    assert.match(select, new RegExp(`\\b${column}\\b`), column);
  }
});

test('the units snapshot carries fleet_type and seat — a truck is not a number', () => {
  // `(fleet_type, unit_number, seat)` is the truck's identity. Selecting the
  // bare number puts Company 001 and Lease 001 in one bucket, which is the
  // exact confusion migration 0047 exists to remove.
  const select = selectFor('driver_units');
  assert.match(select, /\bfleet_type\b/);
  assert.match(select, /\bseat\b/);
  assert.match(select, /\bunit_number\b/);
  assert.match(select, /\bperson_id\b/);
});

test('the people snapshot carries the display name and the merge pointer', () => {
  // The board-link rule matches on `display_name`, and a merged person must
  // never be offered as a candidate.
  const select = selectFor('driver_people');
  assert.match(select, /\bdisplay_name\b/);
  assert.match(select, /\bmerged_into_person_id\b/);
});
