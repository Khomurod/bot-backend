const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const EMPLOYEE_GROUP_ID = -1009999;

function loadService({ profile, currentStatus, settings, telegramOverrides = {} }) {
  const servicePath = path.resolve(__dirname, '../services/homeTimeService.js');
  const dbPath = path.resolve(__dirname, '../database/db.js');
  const htPath = path.resolve(__dirname, '../database/homeTime.js');
  const htmlPath = path.resolve(__dirname, '../services/telegramHtml.js');
  const roadBonusPath = path.resolve(__dirname, '../services/roadBonusNotifierService.js');
  const configPath = path.resolve(__dirname, '../config/config.js');

  for (const p of [servicePath, dbPath, htPath, htmlPath, roadBonusPath, configPath]) delete require.cache[p];

  const inserts = [];
  const sends = [];
  const upserts = [];
  const roadBonusPosts = [];

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
        const row = { id: inserts.length + 1, ...payload };
        inserts.push(row);
        return row;
      },
    },
  };
  require.cache[htmlPath] = { exports: { safeSend: async (fn) => fn() } };
  // The extra-week bonus summary is delegated to roadBonusNotifierService; mock
  // it so we can assert it was invoked without exercising its DB/telegram path.
  require.cache[roadBonusPath] = {
    exports: {
      async postCompletedRoadLeg(telegram, historyRow, opts) {
        roadBonusPosts.push({ historyRow, opts });
        return { posted: true };
      },
    },
  };
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
    roadBonusPosts,
  };
}

test('owner operator road trip is recorded but posts nothing anywhere', async () => {
  const {
    service, telegram, inserts, sends, roadBonusPosts,
  } = loadService({
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
  // Owner-operators never trigger any post — no recognition and no bonus summary.
  assert.equal(sends.length, 0);
  assert.equal(roadBonusPosts.length, 0);
});

test('company driver home after over-allowance posts NOTHING to the employee group — the "is home!" message is retired', async () => {
  // The owner asked for the 🏠🎉 "<driver> is home! Off the road after N weeks…
  // welcome back!" post to the EMPLOYEE group to be removed entirely
  // (2026-10-06). The trip, its bonus and the separate road-bonus summary are
  // untouched — only that one message is gone.
  const {
    service, telegram, inserts, sends, roadBonusPosts,
  } = loadService({
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

  // Nothing at all is sent to the employee group.
  assert.equal(sends.filter((s) => s.chatId === EMPLOYEE_GROUP_ID).length, 0);
  assert.ok(!sends.some((s) => /is home!/.test(s.text || '')), 'no "is home!" message anywhere');

  // AND NO BONUS SUMMARY YET (owner's rule, 2026-10-06): the bonus is decided
  // after the home stay — home longer than the allowance forfeits it — so the
  // leg is born waiting, and the road-bonus poller decides and posts it once
  // the driver is back on the road.
  assert.equal(roadBonusPosts.length, 0, 'nothing is posted at the moment the driver gets home');
  assert.equal(inserts[0].bonusDecision, 'waiting_home_stay');
});

test('a silent import records the leg already claimed and never waiting for a decision', async () => {
  const { service, telegram, inserts } = loadService({
    profile: { first_name: 'Company', last_name: 'Driver', unit_number: '2614', driver_type: 'company_driver' },
    currentStatus: { state: 'road', state_since: '2026-01-01T00:00:00Z' },
  });
  await service.applyStateTransition(
    telegram,
    { id: 8, telegram_group_id: '-1008', group_type: 'driver', group_name: 'WENZE UNIT # 2614 COMPANY DRIVER (COMPANY DRIVER)' },
    { newState: 'home', eventAt: '2026-02-12T00:00:00Z', announce: false, statusText: 'import' }
  );
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].bonusUsd, 200);
  assert.equal(inserts[0].bonusDecision, null);
  assert.ok(inserts[0].bonusPostedAt, 'born claimed, so it is never posted');
});

test('company driver home WITHIN allowance posts nothing', async () => {
  const {
    service, telegram, inserts, sends, roadBonusPosts,
  } = loadService({
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
  assert.equal(roadBonusPosts.length, 0);
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

test('road→home transition records state=home with state_since = the home start time', async () => {
  const { service, telegram, upserts } = loadService({
    profile: { first_name: 'C', last_name: 'D', unit_number: '2', driver_type: 'company_driver' },
    currentStatus: { state: 'road', state_since: '2026-01-01T00:00:00Z' },
  });

  const homeAtSecs = Math.floor(Date.parse('2026-01-20T15:30:00Z') / 1000);
  await service.handleDriverGroupStatus(
    telegram,
    { id: 11, telegram_group_id: '-1011', group_type: 'driver', group_name: 'WENZE UNIT # 2 COMPANY DRIVER' },
    { text: 'Status: Home', date: homeAtSecs }
  );

  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].state, 'home');
  // state_since becomes the moment the driver reported home — the home start date.
  assert.equal(upserts[0].stateSince, new Date(homeAtSecs * 1000).toISOString());
});
