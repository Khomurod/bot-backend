const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function loadService({
  profile, currentStatus, settings, openRoadStatuses = [], employeeGroupId = '-999employee',
  telegramOverrides = {},
} = {}) {
  const servicePath = path.resolve(__dirname, '../services/homeTimeService.js');
  const configPath = path.resolve(__dirname, '../config/config.js');
  const dbPath = path.resolve(__dirname, '../database/db.js');
  const htPath = path.resolve(__dirname, '../database/homeTime.js');
  const htmlPath = path.resolve(__dirname, '../services/telegramHtml.js');
  const bonusPath = path.resolve(__dirname, '../services/mileageBonusConstants.js');

  for (const p of [servicePath, configPath, dbPath, htPath, htmlPath, bonusPath]) delete require.cache[p];

  const inserts = [];
  const sends = [];
  const weeksNotifiedCalls = [];

  require.cache[configPath] = { exports: { employeeGroupId } };
  require.cache[dbPath] = {
    exports: {
      async getDriverProfileByGroupId() {
        return profile;
      },
    },
  };
  require.cache[htPath] = {
    exports: {
      async getHomeTimeSettings() {
        return settings || { enabled: true, road_allowance_weeks: 4, bonus_per_week: 100 };
      },
      async getDriverHomeStatus() {
        return currentStatus;
      },
      async upsertDriverHomeStatus(payload) {
        return payload;
      },
      async touchDriverHomeStatus() {
        return null;
      },
      async insertRoadHistory(payload) {
        inserts.push(payload);
        return payload;
      },
      async listOpenRoadStatuses() {
        return openRoadStatuses;
      },
      async setWeeksBonusNotified(groupId, weeksNotified) {
        weeksNotifiedCalls.push({ groupId, weeksNotified });
        const row = openRoadStatuses.find((r) => r.group_id === groupId);
        if (row) row.weeks_bonus_notified = weeksNotified;
        return row || null;
      },
    },
  };
  require.cache[htmlPath] = { exports: { safeSend: async (fn) => fn() } };
  require.cache[bonusPath] = { exports: { BONUS_GROUP_CHAT_ID: -12345 } };

  const telegram = {
    async sendMessage(chatId, text) {
      sends.push({ chatId, text });
      return { message_id: 1 };
    },
    ...telegramOverrides,
  };

  return {
    service: require(servicePath),
    telegram,
    inserts,
    sends,
    weeksNotifiedCalls,
  };
}

test('owner operator road trip is recorded but does not trigger any group post', async () => {
  const { service, telegram, inserts, sends } = loadService({
    profile: {
      first_name: 'Owner',
      last_name: 'Operator',
      unit_number: '310',
      driver_type: 'owner',
    },
    currentStatus: {
      state: 'road',
      state_since: '2026-01-01T00:00:00Z',
    },
  });

  await service.handleDriverGroupStatus(
    telegram,
    { id: 7, telegram_group_id: '-1007', group_type: 'driver', group_name: 'WENZE UNIT # 310 OWNER OPERATOR' },
    { text: 'Status: Home', date: Math.floor(Date.parse('2026-02-12T00:00:00Z') / 1000) }
  );

  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].daysOnRoad, 42);
  assert.equal(inserts[0].exceededWeeks, 2);
  assert.equal(inserts[0].bonusUsd, 0);
  assert.equal(sends.length, 0);
});

test('company driver homecoming posts a recognition message to the employee group, not the bonus group', async () => {
  const { service, telegram, inserts, sends } = loadService({
    profile: {
      first_name: 'Company',
      last_name: 'Driver',
      unit_number: '2614',
      driver_type: 'company_driver',
    },
    currentStatus: {
      state: 'road',
      state_since: '2026-01-01T00:00:00Z',
    },
    employeeGroupId: '-999employee',
  });

  await service.handleDriverGroupStatus(
    telegram,
    { id: 8, telegram_group_id: '-1008', group_type: 'driver', group_name: 'WENZE UNIT # 2614 COMPANY DRIVER (COMPANY DRIVER)' },
    { text: 'Status: Home', date: Math.floor(Date.parse('2026-02-12T00:00:00Z') / 1000) }
  );

  // History still records the full computed bonus (admin audit trail)...
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].bonusUsd, 200);
  assert.equal(inserts[0].exceededWeeks, 2);

  // ...but the only message sent is a recognition note to the employee group.
  assert.equal(sends.length, 1);
  assert.equal(sends[0].chatId, '-999employee');
  assert.match(sends[0].text, /home after.*42 days/s);
  assert.match(sends[0].text, /6 weeks/);
  assert.doesNotMatch(sends[0].text, /\$/);
});

test('homecoming within the allowance (no exceeded weeks) sends no recognition message', async () => {
  const { service, telegram, sends } = loadService({
    profile: {
      first_name: 'Company',
      last_name: 'Driver',
      unit_number: '100',
      driver_type: 'company_driver',
    },
    currentStatus: {
      state: 'road',
      state_since: '2026-01-01T00:00:00Z',
    },
  });

  await service.handleDriverGroupStatus(
    telegram,
    { id: 9, telegram_group_id: '-1009', group_type: 'driver', group_name: 'WENZE UNIT # 100' },
    { text: 'Status: Home', date: Math.floor(Date.parse('2026-01-20T00:00:00Z') / 1000) }
  );

  assert.equal(sends.length, 0);
});

function daysAgoIso(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

function openRoadRow(overrides = {}) {
  return {
    group_id: 8,
    state: 'road',
    weeks_bonus_notified: 0,
    group_name: 'WENZE UNIT # 2614 COMPANY DRIVER (COMPANY DRIVER)',
    group_active: true,
    first_name: 'Company',
    last_name: 'Driver',
    unit_number: '2614',
    driver_type: 'company_driver',
    ...overrides,
  };
}

test('checkRoadBonusMilestones sends nothing until the 5th week is FULLY complete', async () => {
  const { service, telegram, sends } = loadService({
    settings: { enabled: true, road_allowance_weeks: 4, bonus_per_week: 100 },
    // 34 days on the road — 6 days into the 5th week, not yet a full extra week.
    openRoadStatuses: [openRoadRow({ state_since: daysAgoIso(34) })],
  });

  const result = await service.checkRoadBonusMilestones(telegram);
  assert.equal(result.notified, 0);
  assert.equal(sends.length, 0);
});

test('checkRoadBonusMilestones posts a $100 bonus to the bonus group the moment a company driver completes the 5th week', async () => {
  const { service, telegram, sends, weeksNotifiedCalls } = loadService({
    settings: { enabled: true, road_allowance_weeks: 4, bonus_per_week: 100 },
    // 35 days on the road = exactly 5 full weeks (4-week allowance + 1 full extra week).
    openRoadStatuses: [openRoadRow({ state_since: daysAgoIso(35) })],
  });

  const result = await service.checkRoadBonusMilestones(telegram);
  assert.equal(result.notified, 1);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].chatId, -12345);
  assert.match(sends[0].text, /week.*5/i);
  assert.match(sends[0].text, /\$100 bonus/);
  assert.deepEqual(weeksNotifiedCalls, [{ groupId: 8, weeksNotified: 1 }]);
});

test('checkRoadBonusMilestones is idempotent and catches up on multiple missed weeks', async () => {
  // 42 days on the road = 2 full weeks past the 4-week allowance (weeks 5 and 6).
  const { service, telegram, sends, weeksNotifiedCalls } = loadService({
    settings: { enabled: true, road_allowance_weeks: 4, bonus_per_week: 100 },
    openRoadStatuses: [openRoadRow({ state_since: daysAgoIso(42) })],
  });

  const first = await service.checkRoadBonusMilestones(telegram);
  assert.equal(first.notified, 2);
  assert.equal(sends.length, 2);
  assert.ok(sends.every((s) => s.chatId === -12345));
  assert.match(sends[0].text, /week.*5/i);
  assert.match(sends[1].text, /week.*6/i);
  assert.match(sends[0].text, /\$100 bonus/);
  assert.deepEqual(weeksNotifiedCalls.map((c) => c.weeksNotified), [1, 2]);

  // Running again immediately must not re-notify already-covered weeks.
  const second = await service.checkRoadBonusMilestones(telegram);
  assert.equal(second.notified, 0);
  assert.equal(sends.length, 2);
});

test('checkRoadBonusMilestones never notifies owner-operators', async () => {
  const { service, telegram, sends } = loadService({
    settings: { enabled: true, road_allowance_weeks: 4, bonus_per_week: 100 },
    openRoadStatuses: [openRoadRow({
      group_id: 11,
      state_since: daysAgoIso(42),
      group_name: 'WENZE UNIT # 310 OWNER OPERATOR',
      driver_type: 'owner',
    })],
  });

  const result = await service.checkRoadBonusMilestones(telegram);
  assert.equal(result.notified, 0);
  assert.equal(sends.length, 0);
});

test('checkRoadBonusMilestones skips everything when home-time tracking is disabled', async () => {
  const { service, telegram, sends } = loadService({
    settings: { enabled: false, road_allowance_weeks: 4, bonus_per_week: 100 },
    openRoadStatuses: [openRoadRow({ state_since: daysAgoIso(42) })],
  });

  const result = await service.checkRoadBonusMilestones(telegram);
  assert.equal(result.checked, 0);
  assert.equal(result.notified, 0);
  assert.equal(sends.length, 0);
});

test('checkRoadBonusMilestones skips inactive/archived groups', async () => {
  const { service, telegram, sends } = loadService({
    settings: { enabled: true, road_allowance_weeks: 4, bonus_per_week: 100 },
    openRoadStatuses: [openRoadRow({ state_since: daysAgoIso(42), group_active: false })],
  });

  const result = await service.checkRoadBonusMilestones(telegram);
  assert.equal(result.notified, 0);
  assert.equal(sends.length, 0);
});
