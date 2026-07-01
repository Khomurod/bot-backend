const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const EMPLOYEE_GROUP_ID = -1009999;
const BONUS_GROUP_ID = -12345;

function loadService({ profile, currentStatus, settings, telegramOverrides = {} }) {
  const servicePath = path.resolve(__dirname, '../services/homeTimeService.js');
  const dbPath = path.resolve(__dirname, '../database/db.js');
  const htPath = path.resolve(__dirname, '../database/homeTime.js');
  const htmlPath = path.resolve(__dirname, '../services/telegramHtml.js');
  const bonusPath = path.resolve(__dirname, '../services/mileageBonusConstants.js');
  const configPath = path.resolve(__dirname, '../config/config.js');

  for (const p of [servicePath, dbPath, htPath, htmlPath, bonusPath, configPath]) delete require.cache[p];

  const inserts = [];
  const sends = [];
  const upserts = [];

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
        upserts.push(payload);
        return payload;
      },
      async touchDriverHomeStatus() {
        return null;
      },
      async insertRoadHistory(payload) {
        inserts.push(payload);
        return payload;
      },
    },
  };
  require.cache[htmlPath] = { exports: { safeSend: async (fn) => fn() } };
  require.cache[bonusPath] = { exports: { BONUS_GROUP_CHAT_ID: BONUS_GROUP_ID } };
  require.cache[configPath] = { exports: { employeeGroupId: EMPLOYEE_GROUP_ID } };

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
    upserts,
  };
}

test('owner operator road trip is recorded but posts nothing anywhere', async () => {
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
  // Owner-operators never trigger any post (exceededWeeks bonus is 0, and the
  // recognition is gated on exceededWeeks which computeRoadBonus reports as 0).
  assert.equal(sends.length, 0);
});

test('company driver home after over-allowance posts recognition to EMPLOYEE group with no dollar amount', async () => {
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
  });

  await service.handleDriverGroupStatus(
    telegram,
    { id: 8, telegram_group_id: '-1008', group_type: 'driver', group_name: 'WENZE UNIT # 2614 COMPANY DRIVER (COMPANY DRIVER)' },
    { text: 'Status: Home', date: Math.floor(Date.parse('2026-02-12T00:00:00Z') / 1000) }
  );

  // Trip still recorded with its computed bonus for the admin/history.
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].bonusUsd, 200);

  // Exactly one post — recognition, to the EMPLOYEE group, not the bonus group.
  assert.equal(sends.length, 1);
  assert.equal(sends[0].chatId, EMPLOYEE_GROUP_ID);
  assert.notEqual(sends[0].chatId, BONUS_GROUP_ID);
  // No dollar amounts in the recognition message.
  assert.doesNotMatch(sends[0].text, /\$/);
  assert.match(sends[0].text, /6 weeks/); // 42 days on road
});

test('company driver home WITHIN allowance posts nothing', async () => {
  const { service, telegram, inserts, sends } = loadService({
    profile: {
      first_name: 'Company',
      last_name: 'Driver',
      unit_number: '99',
      driver_type: 'company_driver',
    },
    currentStatus: {
      state: 'road',
      state_since: '2026-01-01T00:00:00Z',
    },
  });

  await service.handleDriverGroupStatus(
    telegram,
    { id: 9, telegram_group_id: '-1009', group_type: 'driver', group_name: 'WENZE UNIT # 99 COMPANY DRIVER' },
    // 3 weeks on the road (< 4-week allowance)
    { text: 'Status: Home', date: Math.floor(Date.parse('2026-01-22T00:00:00Z') / 1000) }
  );

  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].exceededWeeks, 0);
  assert.equal(sends.length, 0);
});

test('every transition resets the road-bonus watermark to 0', async () => {
  const { service, telegram, upserts } = loadService({
    profile: { first_name: 'C', last_name: 'D', unit_number: '1', driver_type: 'company_driver' },
    currentStatus: { state: 'home', state_since: '2026-01-01T00:00:00Z' },
  });

  await service.handleDriverGroupStatus(
    telegram,
    { id: 10, telegram_group_id: '-1010', group_type: 'driver', group_name: 'WENZE UNIT # 1 COMPANY DRIVER' },
    { text: 'Status: Ready to roll', date: Math.floor(Date.parse('2026-02-01T00:00:00Z') / 1000) }
  );

  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].state, 'road');
  assert.equal(upserts[0].roadBonusWeeksNotified, 0);
});
