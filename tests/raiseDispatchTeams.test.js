const test = require('node:test');
const assert = require('node:assert/strict');

// ─── Mock IO / env modules before loading the service ───
require.cache[require.resolve('../config/config')] = {
  exports: { jwtSecret: 'test', renderExternalUrl: 'https://example.test', gmailUser: '', gmailAppPassword: '' },
};
require.cache[require.resolve('../bot/bot')] = {
  exports: { bot: { telegram: { sendMessage: async () => ({ message_id: 1 }) } } },
};
require.cache[require.resolve('../database/db')] = { exports: { claimServiceRun: async () => true } };
require.cache[require.resolve('../services/datatruckApiService')] = { exports: { isConfigured: () => false } };
require.cache[require.resolve('../database/messageRoutingSettings')] = {
  exports: { getGroupId: async () => null, missingGroupMessage: () => 'not configured' },
};

// Driver Groups source of truth (canonical directory rows).
const DIRECTORY_ROWS = [
  {
    group_type: 'driver', group_id: 10, profile_id: 100, telegram_group_id: '-100010',
    first_name: 'John', last_name: 'Doe', display_name: 'John Doe', primary_display_name: 'John Doe',
    unit_number: '2614', driver_type: 'company_driver', group_name: 'WENZE UNIT # 2614 John Doe (COMPANY DRIVER)', inactive: false,
  },
  {
    group_type: 'driver', group_id: 11, profile_id: 101, telegram_group_id: '-100011',
    first_name: 'Jane', last_name: 'Roe', display_name: 'Jane Roe', primary_display_name: 'Jane Roe',
    unit_number: null, driver_type: 'company_driver', group_name: 'WENZE UNIT Jane Roe', inactive: false,
  },
  {
    group_type: 'driver', group_id: 12, profile_id: 102, telegram_group_id: '-100012',
    first_name: 'Ollie', last_name: 'Owner', display_name: 'Ollie Owner', primary_display_name: 'Ollie Owner',
    unit_number: '900', driver_type: 'owner', group_name: 'WENZE UNIT # 900 Ollie Owner (OWNER OPERATOR)', inactive: false,
  },
];
require.cache[require.resolve('../services/driverGroupDirectoryService')] = {
  exports: { listCanonicalDriverGroups: async () => DIRECTORY_ROWS },
};

// Mutable fake of the raiseApproval DB layer.
const fakeRa = {
  _activeAssignments: [],
  _assignCalls: [],
  _memberCreates: [],
  _links: [],
  _reviewFlags: [],
  _unlinked: [],
  listActiveDriverAssignments: async () => fakeRa._activeAssignments,
  assignDriverToTeam: async (args) => {
    fakeRa._assignCalls.push(args);
    const conflict = fakeRa._activeAssignments.find(
      (a) => a.driver_profile_id === args.driverProfileId && a.team_id !== args.teamId,
    );
    if (conflict && !args.force) {
      const err = new Error(`This driver is already assigned to ${conflict.team_name}.`);
      err.code = 'DRIVER_ON_OTHER_TEAM';
      err.status = 409;
      err.conflictTeam = { id: conflict.team_id, name: conflict.team_name };
      throw err;
    }
    return { assignment: { id: 1, ...args }, moved: Boolean(conflict && args.force), alreadyOnTeam: false };
  },
  createTeamMember: async (teamId, member) => { fakeRa._memberCreates.push({ teamId, member }); return { id: 1, team_id: teamId, ...member }; },
  updateTeamMember: async (id, patch) => ({ id, ...patch }),
  listUnlinkedTeamDrivers: async () => fakeRa._unlinked,
  linkTeamDriverToProfile: async (id, patch) => { fakeRa._links.push({ id, patch }); return { id }; },
  markTeamDriverNeedsReview: async (id, val) => { fakeRa._reviewFlags.push({ id, val }); return { id }; },
};
require.cache[require.resolve('../database/raiseApproval')] = { exports: fakeRa };

const raise = require('../services/raiseApprovalService');

test('listAssignableDrivers is company-drivers-only by default (excludes owners)', async () => {
  fakeRa._activeAssignments = [];
  const drivers = await raise.listAssignableDrivers();
  const names = drivers.map((d) => d.driver_name);
  assert.ok(names.includes('John Doe'));
  assert.ok(names.includes('Jane Roe'));
  assert.ok(!names.includes('Ollie Owner'), 'owner-operator must not appear in the 72–75 CPM list');
});

test('listAssignableDrivers surfaces the current team + warnings', async () => {
  fakeRa._activeAssignments = [{ driver_profile_id: 100, group_id: 10, team_id: 7, team_name: 'Team A' }];
  const drivers = await raise.listAssignableDrivers();
  const john = drivers.find((d) => d.driver_profile_id === 100);
  const jane = drivers.find((d) => d.driver_profile_id === 101);
  assert.equal(john.assigned_team_id, 7);
  assert.equal(john.assigned_team_name, 'Team A');
  assert.ok(jane.warnings.includes('missing_unit'));
  assert.equal(jane.assigned_team_id, null);
});

test('listAssignableDrivers search filters by name/unit/group', async () => {
  fakeRa._activeAssignments = [];
  const byUnit = await raise.listAssignableDrivers({ search: '2614' });
  assert.equal(byUnit.length, 1);
  assert.equal(byUnit[0].driver_name, 'John Doe');
});

test('assignDriverToTeamFromGroups resolves the driver from Driver Groups and links profile/group', async () => {
  fakeRa._activeAssignments = [];
  fakeRa._assignCalls = [];
  await raise.assignDriverToTeamFromGroups({ teamId: 5, groupId: 10 });
  assert.equal(fakeRa._assignCalls.length, 1);
  const call = fakeRa._assignCalls[0];
  assert.equal(call.driverProfileId, 100);
  assert.equal(call.groupId, 10);
  assert.equal(call.unitNumber, '2614');
  assert.equal(call.driverNormalizedName, 'JOHN DOE');
});

test('assignDriverToTeamFromGroups surfaces a conflict when the driver is on another team', async () => {
  fakeRa._activeAssignments = [{ driver_profile_id: 100, group_id: 10, team_id: 7, team_name: 'Team A' }];
  await assert.rejects(
    () => raise.assignDriverToTeamFromGroups({ teamId: 5, groupId: 10, force: false }),
    (err) => err.code === 'DRIVER_ON_OTHER_TEAM' && err.conflictTeam.name === 'Team A',
  );
});

test('assignDriverToTeamFromGroups with force moves the driver', async () => {
  fakeRa._activeAssignments = [{ driver_profile_id: 100, group_id: 10, team_id: 7, team_name: 'Team A' }];
  const res = await raise.assignDriverToTeamFromGroups({ teamId: 5, groupId: 10, force: true });
  assert.equal(res.moved, true);
});

test('assignDriverToTeamFromGroups rejects an unknown driver', async () => {
  await assert.rejects(
    () => raise.assignDriverToTeamFromGroups({ teamId: 5, groupId: 9999 }),
    (err) => err.code === 'DRIVER_NOT_FOUND',
  );
});

test('createTeamMember normalizes the Telegram username and rejects bad input', async () => {
  fakeRa._memberCreates = [];
  await raise.createTeamMember(5, { name: 'Alice', telegramUsername: '@Alice_Dispatch' });
  assert.equal(fakeRa._memberCreates[0].member.telegramUsername, 'alice_dispatch');

  await assert.rejects(() => raise.createTeamMember(5, { telegramUsername: '@a!' }),
    (err) => err.code === 'BAD_USERNAME');
  await assert.rejects(() => raise.createTeamMember(5, {}),
    (err) => err.code === 'EMPTY_MEMBER');
});

test('backfillLegacyTeamDriverLinks links matches by normalized name and flags the rest', async () => {
  fakeRa._links = [];
  fakeRa._reviewFlags = [];
  fakeRa._unlinked = [
    { id: 1, driver_normalized_name: 'JOHN DOE', needs_review: false },
    { id: 2, driver_normalized_name: 'GHOST DRIVER', needs_review: false },
  ];
  const res = await raise.backfillLegacyTeamDriverLinks();
  assert.equal(res.linked, 1);
  assert.equal(res.needsReview, 1);
  assert.equal(fakeRa._links[0].patch.driverProfileId, 100);
  assert.equal(fakeRa._reviewFlags[0].id, 2);
});
