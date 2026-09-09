/**
 * Giving `groups.samsara_vehicle_id` a writer — and refusing to guess.
 *
 * The column has been in the schema since the beginning, indexed, with a reader
 * (`getGroupBySamsaraId`) and a writer (`updateGroupSamsaraId`) that nothing
 * ever called. It is NULL on all 209 production rows, which is why every
 * cross-system join still resolves a driver by parsing a string out of a chat
 * title. The duplicate-unit scan already resolves a group to a vehicle in order
 * to compare driver names, so the resolution exists; it was simply thrown away.
 *
 * These tests are mostly about what must NOT be written. A wrong id in this
 * column is worse than a NULL one: NULL falls back to the string parse that has
 * always run, while a wrong id is believed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.BOT_TOKEN ||= 'test';
process.env.TELEGRAM_BOT_TOKEN ||= 'test';
process.env.JWT_SECRET ||= 'test';
process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef';

const {
  resolveVehicleLinks, writeVehicleLinks,
} = require('../services/duplicateUnitCheckService');

function row(groupId, unit, first, last, samsaraVehicleId = null) {
  return {
    group_id: groupId,
    group_name: `WENZE UNIT # ${unit} ${first} ${last}`,
    unit_number: unit,
    first_name: first,
    last_name: last,
    samsara_vehicle_id: samsaraVehicleId,
  };
}

function vehicle(id, name, time = '2026-05-01T00:00:00Z') {
  return { id, name, gps: { time } };
}

test('an unambiguous unit with an agreeing driver name links', () => {
  const links = resolveVehicleLinks(
    [row(1, '100', 'John', 'Doe')],
    [vehicle('v-100', '100 JOHN DOE')]
  );
  assert.deepEqual(links, [{
    groupId: 1, vehicleId: 'v-100', previousVehicleId: null,
    unitNumber: '100', reason: 'unique_unit',
  }]);
});

test('a label that is only the unit number links — there is no name to disagree with', () => {
  const links = resolveVehicleLinks(
    [row(1, '305', 'John', 'Doe')],
    [vehicle('v-305', '305')]
  );
  assert.equal(links.length, 1);
  assert.equal(links[0].vehicleId, 'v-305');
});

test('a label the name extractor cannot separate links nothing', () => {
  // "2021 Freightliner 305" is a real Samsara label shape, and
  // `extractDriverNameFromVehicleLabel` hands back the whole string rather than
  // a name. The same scan therefore files a `name_mismatch` for it — so a link
  // here would contradict a report written moments earlier in the same run.
  // Whichever of the two is wrong, they must not disagree; and a NULL id falls
  // back to the string parse that has always run, while a wrong one is believed.
  const links = resolveVehicleLinks(
    [row(1, '305', 'John', 'Doe')],
    [vehicle('v-305', '2021 Freightliner 305')]
  );
  assert.deepEqual(links, []);
});

test('a NAME MISMATCH links nothing', () => {
  // This is already reported as `name_mismatch`. Writing the id anyway would
  // cement the wrong truck against a driver in the one authoritative column.
  const links = resolveVehicleLinks(
    [row(1, '100', 'John', 'Doe')],
    [vehicle('v-100', '100 JANE ROE')]
  );
  assert.deepEqual(links, []);
});

test('an ambiguous unit links nothing', () => {
  const links = resolveVehicleLinks(
    [row(1, '300', 'Someone', 'Else')],
    [vehicle('a', '300 NIKE AUGUSTE'), vehicle('b', '300 TESFAMARIAM YOSIEF', '2026-05-01T01:00:00Z')]
  );
  assert.deepEqual(links, []);
});

test('two groups resolving to ONE vehicle link neither', () => {
  // Unit 001 sits on four active groups in production. `selectVehicleByUnit` is
  // called once per group and neither call can see the other, so both would
  // happily claim the same vehicle — and `getGroupBySamsaraId` answers with
  // LIMIT 1, i.e. an arbitrary driver, silently.
  const links = resolveVehicleLinks(
    [row(1, '001', 'John', 'Doe'), row(2, '001', 'Jane', 'Roe')],
    [vehicle('v-001', '001')]
  );
  assert.deepEqual(links, [], 'a contested vehicle links to nobody');
});

test('two groups on one unit with DISTINCT vehicles each link to their own', () => {
  const links = resolveVehicleLinks(
    [row(1, '001', 'John', 'Doe'), row(2, '001', 'Jane', 'Roe')],
    [vehicle('v-a', '001 JOHN DOE'), vehicle('v-b', '001 JANE ROE', '2026-05-01T01:00:00Z')]
  );
  assert.deepEqual(
    links.map((l) => [l.groupId, l.vehicleId]).sort(),
    [[1, 'v-a'], [2, 'v-b']]
  );
});

test('an unchanged link is not rewritten', () => {
  const links = resolveVehicleLinks(
    [row(1, '100', 'John', 'Doe', 'v-100')],
    [vehicle('v-100', '100 JOHN DOE')]
  );
  assert.deepEqual(links, [], 'otherwise this is 209 pointless UPDATEs an hour');
});

test('a truck change re-points the link and says it was a re-point', () => {
  const links = resolveVehicleLinks(
    [row(1, '322', 'Sirojiddin', 'Davurov', 'v-320')],
    [vehicle('v-322', '322 SIROJIDDIN DAVUROV')]
  );
  assert.equal(links.length, 1);
  assert.equal(links[0].vehicleId, 'v-322');
  assert.equal(links[0].previousVehicleId, 'v-320');
});

test('no Samsara data means no links, not cleared links', () => {
  assert.deepEqual(resolveVehicleLinks([row(1, '100', 'John', 'Doe', 'v-100')], null), []);
  assert.deepEqual(resolveVehicleLinks([row(1, '100', 'John', 'Doe', 'v-100')], []), []);
});

test('a vehicle with no id is not a link', () => {
  assert.deepEqual(
    resolveVehicleLinks([row(1, '100', 'John', 'Doe')], [{ name: '100 JOHN DOE', gps: {} }]),
    []
  );
});

test('writeVehicleLinks counts new links and re-points separately', async () => {
  const calls = [];
  const groups = require('../database/groups');
  const original = groups.updateGroupSamsaraId;
  groups.updateGroupSamsaraId = async (groupId, vehicleId) => {
    calls.push([groupId, vehicleId]);
    return { id: groupId };
  };
  try {
    const result = await writeVehicleLinks([
      { groupId: 1, vehicleId: 'v-1', previousVehicleId: null },
      { groupId: 2, vehicleId: 'v-2', previousVehicleId: 'v-old' },
    ]);
    assert.deepEqual(result, { linked: 1, relinked: 1 });
    assert.deepEqual(calls, [[1, 'v-1'], [2, 'v-2']]);
  } finally {
    groups.updateGroupSamsaraId = original;
  }
});

test('one failing write does not abort the rest of the scan', async () => {
  const groups = require('../database/groups');
  const original = groups.updateGroupSamsaraId;
  groups.updateGroupSamsaraId = async (groupId) => {
    if (groupId === 1) throw new Error('deadlock detected');
    return { id: groupId };
  };
  try {
    const result = await writeVehicleLinks([
      { groupId: 1, vehicleId: 'v-1', previousVehicleId: null },
      { groupId: 2, vehicleId: 'v-2', previousVehicleId: null },
    ]);
    assert.deepEqual(result, { linked: 1, relinked: 0 });
  } finally {
    groups.updateGroupSamsaraId = original;
  }
});
