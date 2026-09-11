/**
 * The person-layer and cross-system checks — pure, on the shapes the fleet has.
 *
 * Every fixture is a disagreement between two things the database believes:
 * a chat with no person, a person on two chats, a truck two people claim, a
 * Samsara vehicle on two chats, a fuel watch or a route on a chat nobody is in,
 * a team seat pointing at the chat a driver left.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const layer = require('../services/operations/checks/identityLayer');
const systems = require('../services/operations/checks/systems');

const group = (id, name, extra = {}) => ({ id, group_name: name, group_type: 'driver', active: true, ...extra });
const profile = (group_id, unit_number, extra = {}) => ({ group_id, unit_number, status: 'active', ...extra });
const snapshotOf = (over = {}) => {
  const groups = over.groups || [];
  return {
    groups, groupsById: new Map(groups.map((g) => [g.id, g])),
    profiles: [], people: [], personGroups: [], units: [],
    fuelAlerts: [], teamDrivers: [], mileageProgress: [], routeAssignments: [],
    ...over,
  };
};
const keysOf = (findings) => findings.map((f) => f.checkKey);

// ─── the person layer ────────────────────────────────────────────────────────

test('an active driver group with no person is auto-correctable; an inactive or non-driver one is not reported', () => {
  const findings = layer.checkGroupWithoutPerson(snapshotOf({
    groups: [
      group(1, 'WENZE UNIT # 27 RUSLAN ABDULLAEV'),
      group(2, 'WENZE UNIT # 320 PLACED'),
      group(3, 'WENZE UNIT # 999 GONE', { active: false }),
      group(4, 'HR Personnel', { group_type: 'general' }),
    ],
    personGroups: [{ person_id: 7, group_id: 2 }],
  }));
  assert.deepEqual(findings.map((f) => f.subjectId), [1]);
  assert.equal(findings[0].tier, 'auto');
  assert.equal(findings[0].proposedChange.groupId, 1);
});

test('one person on two ACTIVE chats is a warning for a human; an inactive second chat is fine', () => {
  const findings = layer.checkPersonOnTwoActiveGroups(snapshotOf({
    groups: [group(49, 'WENZE UNIT # 27 RUSLAN ABDULLAEV'), group(541877, 'WENZE UNIT # 27 RUSLAN ABDULLAEV'),
      group(8, 'WENZE UNIT # 8 OLD', { active: false }), group(9, 'WENZE UNIT # 9 B')],
    people: [{ id: 7, display_name: 'RUSLAN ABDULLAEV' }, { id: 8, display_name: 'B' }],
    personGroups: [{ person_id: 7, group_id: 49 }, { person_id: 7, group_id: 541877 },
      { person_id: 8, group_id: 8 }, { person_id: 8, group_id: 9 }],
  }));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].subjectId, 7);
  assert.equal(findings[0].tier, 'warning');
  assert.match(findings[0].title, /RUSLAN ABDULLAEV is on 2 active/);
});

test('a truck the profile claims but another person holds is contested; the same person holding it is not', () => {
  const findings = layer.checkUnitContested(snapshotOf({
    groups: [group(1, 'A'), group(2, 'B')],
    profiles: [profile(1, '001'), profile(2, '320')],
    people: [{ id: 10, display_name: 'OLABODE OLUDAISI' }, { id: 11, display_name: 'STARKS DAYMON' }],
    personGroups: [{ person_id: 10, group_id: 1 }, { person_id: 11, group_id: 2 }],
    units: [{ person_id: 11, unit_number: '001' }, { person_id: 11, unit_number: '320' }],
  }));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].subjectId, 1);
  assert.equal(findings[0].evidence.holderDisplayName, 'STARKS DAYMON');
  assert.equal(findings[0].tier, 'warning', 'only a person knows who is really in the truck');
});

test("a stale unit assignment is auto-correctable only when nobody else holds the profile's truck", () => {
  const snapshot = snapshotOf({
    groups: [group(1, 'A'), group(2, 'B'), group(3, 'C')],
    profiles: [profile(1, '322'), profile(2, '001'), profile(3, '5')],
    personGroups: [{ person_id: 10, group_id: 1 }, { person_id: 11, group_id: 2 }, { person_id: 12, group_id: 3 }],
    // 10 moved 320 → 322 (stale); 11 claims 001 held by 12 (contested, not stale); 12 holds 001, profile says 5.
    units: [{ person_id: 10, unit_number: '320' }, { person_id: 12, unit_number: '001' }],
  });
  const findings = layer.checkStaleUnitAssignment(snapshot);
  assert.deepEqual(findings.map((f) => [f.subjectId, f.proposedChange.from, f.proposedChange.to]),
    [[1, '320', '322'], [3, '001', '5']]);
  assert.equal(findings[0].tier, 'auto');
  assert.deepEqual(keysOf(layer.checkUnitContested(snapshot)), ['identity.unit_contested']);
});

test("'001' and '01' are different trucks here too", () => {
  const findings = layer.checkStaleUnitAssignment(snapshotOf({
    groups: [group(1, 'A')], profiles: [profile(1, '001')],
    personGroups: [{ person_id: 10, group_id: 1 }], units: [{ person_id: 10, unit_number: '01' }],
  }));
  assert.equal(findings.length, 1);
});

test('every person-layer check runs over one snapshot and declares its keys', () => {
  const findings = layer.runIdentityLayerChecks(snapshotOf({ groups: [group(1, 'A')] }));
  assert.deepEqual(keysOf(findings), ['identity.group_without_person']);
  assert.equal(layer.CHECK_KEYS.length, 4);
});

// ─── the systems around it ───────────────────────────────────────────────────

test('one Samsara vehicle on two active chats is reported once, by vehicle', () => {
  const findings = systems.checkSamsaraVehicleOnTwoGroups(snapshotOf({
    groups: [group(1, 'A', { samsara_vehicle_id: 'v-1' }), group(2, 'B', { samsara_vehicle_id: 'v-1' }),
      group(3, 'C', { samsara_vehicle_id: 'v-1', active: false }), group(4, 'D', { samsara_vehicle_id: 'v-2' })],
  }));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].subjectId, 'v-1');
  assert.deepEqual(findings[0].evidence.groups.map((g) => g.groupId), [1, 2]);
});

test("a chat's vehicle disagreeing with the driver's recorded truck is a warning; missing either side is silence", () => {
  const findings = systems.checkSamsaraLinkDisagrees(snapshotOf({
    groups: [group(1, 'A', { samsara_vehicle_id: 'v-1' }), group(2, 'B', { samsara_vehicle_id: 'v-2' }), group(3, 'C')],
    personGroups: [{ person_id: 10, group_id: 1 }, { person_id: 11, group_id: 2 }, { person_id: 12, group_id: 3 }],
    units: [{ person_id: 10, unit_number: '27', samsara_vehicle_id: 'v-9' },
      { person_id: 11, unit_number: '28', samsara_vehicle_id: 'v-2' }, { person_id: 12, unit_number: '29', samsara_vehicle_id: 'v-3' }],
  }));
  assert.deepEqual(findings.map((f) => f.subjectId), [1]);
  assert.equal(findings[0].evidence.unitVehicleId, 'v-9');
});

test('a fuel watch or an active route on an inactive or missing chat is reported; on an active chat it is not', () => {
  const snapshot = snapshotOf({
    groups: [group(1, 'A'), group(2, 'B', { active: false })],
    fuelAlerts: [{ id: 1, group_id: 1, status: 'watching' }, { id: 2, group_id: 2, status: 'watching' },
      { id: 3, group_id: 99, status: 'watching' }, { id: 4, group_id: 2, status: 'expired' }],
    routeAssignments: [{ id: 5, group_id: 1, status: 'active' }, { id: 6, group_id: 2, status: 'active' },
      { id: 7, group_id: 2, status: 'completed' }],
  });
  assert.deepEqual(systems.checkFuelWatchOnInactiveGroup(snapshot).map((f) => f.subjectId), [2, 3]);
  assert.deepEqual(systems.checkRouteOnInactiveGroup(snapshot).map((f) => f.subjectId), [6]);
});

test("a team seat on the chat a driver left proposes the driver's current chat — and only when there is one", () => {
  const findings = systems.checkTeamDriverOnInactiveGroup(snapshotOf({
    groups: [group(49, 'OLD', { active: false }), group(541877, 'NEW'), group(8, 'GONE', { active: false })],
    personGroups: [{ person_id: 7, group_id: 541877 }],
    teamDrivers: [
      { id: 1, team_id: 3, group_id: 49, person_id: 7, driver_name: 'RUSLAN ABDULLAEV', active: true },
      { id: 2, team_id: 3, group_id: 8, person_id: 9, driver_name: 'LEFT', active: true },
      { id: 3, team_id: 3, group_id: 541877, person_id: 7, driver_name: 'FINE', active: true },
    ],
  }));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].subjectId, 1);
  assert.equal(findings[0].tier, 'approval', 'which team a driver sits on is a decision');
  assert.deepEqual(findings[0].proposedChange, { table: 'dispatch_team_drivers', id: 1, field: 'group_id', from: 49, to: 541877 });
});

test('mileage rows without a person are ONE finding, not one per driver', () => {
  const findings = systems.checkMileageWithoutPerson(snapshotOf({
    mileageProgress: [{ id: 1, driver_normalized_name: 'OMAR ALAWAD', person_id: null },
      { id: 2, driver_normalized_name: 'PLACED', person_id: 7 }, { id: 3, driver_normalized_name: 'NEW GUY', person_id: null }],
  }));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].evidence.count, 2);
  assert.deepEqual(findings[0].evidence.names, ['OMAR ALAWAD', 'NEW GUY']);
  assert.deepEqual(systems.checkMileageWithoutPerson(snapshotOf()), []);
});

test('every system check runs over one snapshot and declares its keys', () => {
  // A clean snapshot with no notification settings on it: the destination check
  // stands down when there is no row to read (a deploy in progress is not a
  // misconfiguration), so a healthy fleet still files nothing.
  assert.deepEqual(systems.runSystemChecks(snapshotOf()), []);
  assert.equal(systems.CHECK_KEYS.length, 7);
  // Every key a check can emit must be declared, or `resolveClearedFindings`
  // will not clear it when the condition goes away.
  const emitted = new Set(
    systems.runSystemChecks(snapshotOf({
      notificationSettings: { enabled: true, defaultChatId: null, categoryChatIds: {} },
    })).map((f) => f.checkKey)
  );
  for (const key of emitted) {
    assert.ok(systems.CHECK_KEYS.includes(key), `${key} is emitted but not declared`);
  }
});

test('a person on two ACTIVE chats with different profile units gets NO auto unit-sync — the conflict is reported instead', () => {
  // Otherwise two auto findings would switch the same person's truck back and
  // forth on every sweep, each valid on its own chat's evidence.
  const findings = layer.checkStaleUnitAssignment(snapshotOf({
    groups: [group(49, 'OLD CHAT'), group(541877, 'NEW CHAT'), group(9, 'B')],
    profiles: [profile(49, '27'), profile(541877, '28'), profile(9, '5')],
    personGroups: [{ person_id: 7, group_id: 49 }, { person_id: 7, group_id: 541877 }, { person_id: 8, group_id: 9 }],
    units: [{ person_id: 7, unit_number: '27' }],
  }));
  assert.deepEqual(findings.map((f) => f.subjectId), [9], 'only the unambiguous person is synced');
});

test('mileage rows without a person are keyed by the cohort, so a dismissed cohort does not hide a new one', () => {
  const before = systems.checkMileageWithoutPerson(snapshotOf({
    mileageProgress: [{ id: 1, driver_normalized_name: 'OMAR ALAWAD', person_id: null }],
  }))[0];
  const same = systems.checkMileageWithoutPerson(snapshotOf({
    mileageProgress: [{ id: 1, driver_normalized_name: 'OMAR ALAWAD', person_id: null }],
  }))[0];
  const changed = systems.checkMileageWithoutPerson(snapshotOf({
    mileageProgress: [{ id: 1, driver_normalized_name: 'OMAR ALAWAD', person_id: null },
      { id: 2, driver_normalized_name: 'NEW GUY', person_id: null }],
  }))[0];
  assert.equal(before.subjectId, same.subjectId, 'the same cohort updates one row');
  assert.notEqual(before.subjectId, changed.subjectId, 'a different cohort is a different finding');
  assert.notEqual(before.subjectId, 'unplaced');
});
