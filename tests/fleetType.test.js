'use strict';

/**
 * Fleet type, and the two vocabularies that describe it.
 *
 * `driver_profiles.driver_type` predates the Dispatcher Board and says `owner` /
 * `company_driver`; the Board says `owner_operator` / `company` / `lease`. This
 * module is the only place they are translated, so the tests that matter most
 * here are the ones about what must NOT be guessed in either direction.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FLEET_TYPES, parseFleetLabel, toFleetType, toDriverType,
  fleetTypeFromGroupName, resolveDriverType,
} = require('../lib/drivers/fleetType');

test('the label forms the board actually uses all read correctly', () => {
  const cases = [
    ['JOHN SMITH (COMPANY DRIVER)', FLEET_TYPES.COMPANY],
    ['JOHN SMITH (COMPANY DRIVERS)', FLEET_TYPES.COMPANY],
    ['JOHN SMITH (COMPANY)', FLEET_TYPES.COMPANY],
    ['JANE DOE (LEASE DRIVER)', FLEET_TYPES.LEASE],
    ['JANE DOE (LEASE DRIVERS)', FLEET_TYPES.LEASE],
    ['JANE DOE (LEASE)', FLEET_TYPES.LEASE],
    ['SAM JONES', FLEET_TYPES.OWNER_OPERATOR],
  ];
  for (const [name, expected] of cases) {
    assert.equal(parseFleetLabel(name).fleetType, expected, name);
  }
});

test('the one typo the live board carries is accepted AND said so', () => {
  const r = parseFleetLabel('JOHN SMITH (COMPNAY DRIVER)');
  assert.equal(r.fleetType, FLEET_TYPES.COMPANY);
  assert.equal(r.normalised, true, '"we guessed" is a fact the finding has to carry');
});

test('a label outside the list is unknown, never a closest guess', () => {
  for (const label of ['(CONTRACTOR)', '(OWNER OP)', '(COMPANYY)', '(LEASING)']) {
    const r = parseFleetLabel(`PAT LEE ${label}`);
    assert.equal(r.fleetType, FLEET_TYPES.UNKNOWN, label);
    assert.equal(r.normalised, false);
  }
});

// ── the two vocabularies ─────────────────────────────────────────────────────

test('a stored driver_type reads as its fleet, and an unreadable one is unknown', () => {
  assert.equal(toFleetType('company_driver'), FLEET_TYPES.COMPANY);
  assert.equal(toFleetType('lease'), FLEET_TYPES.LEASE);
  assert.equal(toFleetType('owner'), FLEET_TYPES.OWNER_OPERATOR);
  // NOT owner_operator. The unlabelled default belongs to the board's naming
  // convention; an unreadable stored value means we do not know.
  assert.equal(toFleetType('contractor'), FLEET_TYPES.UNKNOWN);
  assert.equal(toFleetType(null), FLEET_TYPES.UNKNOWN);
  assert.equal(toFleetType(undefined), FLEET_TYPES.UNKNOWN);
});

test('unknown becomes null rather than a stored guess', () => {
  assert.equal(toDriverType(FLEET_TYPES.COMPANY), 'company_driver');
  assert.equal(toDriverType(FLEET_TYPES.LEASE), 'lease');
  assert.equal(toDriverType(FLEET_TYPES.OWNER_OPERATOR), 'owner');
  assert.equal(toDriverType(FLEET_TYPES.UNKNOWN), null,
    'writing "owner" for a driver nobody classified turns a question into a fact');
});

test('the round trip is lossless for every real fleet', () => {
  for (const t of ['company_driver', 'lease', 'owner']) {
    assert.equal(toDriverType(toFleetType(t)), t);
  }
});

// ── group titles ─────────────────────────────────────────────────────────────

test('a group title is read by the same rules as a board row', () => {
  assert.equal(
    fleetTypeFromGroupName('WENZE UNIT # 008 ABDINASIR / IBRAHIM (COMPANY DRIVERS)'),
    FLEET_TYPES.COMPANY
  );
  assert.equal(
    fleetTypeFromGroupName('WENZE UNIT # 310 JAKHONGIR ABDUNABIEV'),
    FLEET_TYPES.OWNER_OPERATOR
  );
});

test('a LEASE group title is finally visible', () => {
  // The substring test this replaces (`/company\s+drivers?/i`) had no lease
  // branch at all, so every lease driver in the fleet read as an owner operator.
  assert.equal(
    fleetTypeFromGroupName('WENZE UNIT # 771 A DRIVER (LEASE DRIVERS)'),
    FLEET_TYPES.LEASE
  );
});

test('a title whose only label is NOT a fleet label is unknown, not owner', () => {
  // Deliberate, and the one behaviour change worth stating: a trailing
  // parenthesis that names something else is a title we cannot classify. The
  // alternative — treating an unrecognised label as the unlabelled default —
  // would quietly file admin chats and mislabelled groups as owner operators.
  assert.equal(fleetTypeFromGroupName('Employee Feedback (Admin)'), FLEET_TYPES.UNKNOWN);
  assert.equal(fleetTypeFromGroupName('Automatic updating (Test)'), FLEET_TYPES.UNKNOWN);
});

test('a status word an operator appended is not a fleet label', () => {
  // `GOCHYYEV INACTIVE` carries no parentheses, so it is still the unlabelled
  // owner-operator default — the status marker does not change the fleet.
  assert.equal(fleetTypeFromGroupName('WENZE UNIT # 27 GOCHYYEV INACTIVE'),
    FLEET_TYPES.OWNER_OPERATOR);
});

// ── which answer wins ────────────────────────────────────────────────────────

test('a stored decision beats the title, and says it was the column', () => {
  const r = resolveDriverType({
    column: 'lease', title: 'WENZE UNIT # 310 X (COMPANY DRIVER)',
  });
  assert.deepEqual(r, { value: 'lease', fleetType: FLEET_TYPES.LEASE, source: 'column' });
});

test('a NULL column falls back to the title, and says it was the title', () => {
  const r = resolveDriverType({ column: null, title: 'W UNIT # 8 A / B (COMPANY DRIVERS)' });
  assert.deepEqual(r, {
    value: 'company_driver', fleetType: FLEET_TYPES.COMPANY, source: 'title',
  });
});

test('an unreadable column is not trusted, and the title is tried instead', () => {
  const r = resolveDriverType({ column: 'contractor', title: 'W UNIT # 310 SAM JONES' });
  assert.equal(r.value, 'owner');
  assert.equal(r.source, 'title');
});

test('nothing to go on answers null with source "none", never a default', () => {
  const r = resolveDriverType({ column: null, title: 'HR Personnel (ADMIN)' });
  assert.deepEqual(r, { value: null, fleetType: FLEET_TYPES.UNKNOWN, source: 'none' });
  assert.deepEqual(resolveDriverType(), {
    value: null, fleetType: FLEET_TYPES.UNKNOWN, source: 'none',
  });
});

test('the source is reported so a caller can tell a decision from a guess', () => {
  // A broadcast that changes who it reaches must be able to say whether it
  // followed a person's decision or a string somebody typed into a chat name.
  const decided = resolveDriverType({ column: 'company_driver', title: 'anything' });
  const guessed = resolveDriverType({ column: null, title: 'W UNIT # 8 X (COMPANY DRIVER)' });
  assert.equal(decided.value, guessed.value);
  assert.notEqual(decided.source, guessed.source);
});
