const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function loadService({ profile, currentStatus, settings, telegramOverrides = {} }) {
  const servicePath = path.resolve(__dirname, '../services/homeTimeService.js');
  const dbPath = path.resolve(__dirname, '../database/db.js');
  const htPath = path.resolve(__dirname, '../database/homeTime.js');
  const htmlPath = path.resolve(__dirname, '../services/telegramHtml.js');
  const bonusPath = path.resolve(__dirname, '../services/mileageBonusConstants.js');

  for (const p of [servicePath, dbPath, htPath, htmlPath, bonusPath]) delete require.cache[p];

  const inserts = [];
  const sends = [];

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
  };
}

test('owner operator road trip is recorded but does not trigger a company bonus post', async () => {
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

test('company driver road trip still posts the extra-week bonus', async () => {
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

  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].bonusUsd, 200);
  assert.equal(sends.length, 1);
  assert.match(sends[0].text, /\$200 bonus/);
});
