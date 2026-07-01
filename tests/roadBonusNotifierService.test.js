const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const BONUS_GROUP_ID = -55555;

/**
 * Load roadBonusNotifierService with all DB/telegram/const dependencies mocked
 * via require.cache injection (matches tests/homeTimeService.test.js).
 *
 * @param {object} opts
 * @param {object} opts.settings           home_time_settings row
 * @param {Array}  opts.rows               listOnRoadStatuses() rows
 */
function loadService({ settings, rows }) {
  const servicePath = path.resolve(__dirname, '../services/roadBonusNotifierService.js');
  const htPath = path.resolve(__dirname, '../database/homeTime.js');
  const htmlPath = path.resolve(__dirname, '../services/telegramHtml.js');
  const bonusPath = path.resolve(__dirname, '../services/mileageBonusConstants.js');
  const parsePath = path.resolve(__dirname, '../services/driverProfileParse.js');

  for (const p of [servicePath, htPath, htmlPath, bonusPath, parsePath]) delete require.cache[p];

  const sends = [];
  const watermarks = [];
  // Mutate the in-memory rows so idempotency across repeated passes is realistic.
  const rowsById = new Map(rows.map((r) => [r.group_id, { ...r }]));

  require.cache[htPath] = {
    exports: {
      async getHomeTimeSettings() {
        return settings;
      },
      async listOnRoadStatuses() {
        return [...rowsById.values()];
      },
      async setRoadBonusWeeksNotified(groupId, n) {
        watermarks.push({ groupId, n });
        const row = rowsById.get(groupId);
        if (row) row.road_bonus_weeks_notified = n;
        return row || null;
      },
    },
  };
  require.cache[htmlPath] = { exports: { safeSend: async (fn) => fn() } };
  require.cache[bonusPath] = { exports: { BONUS_GROUP_CHAT_ID: BONUS_GROUP_ID } };
  require.cache[parsePath] = {
    exports: {
      inferDriverType: (name) => (/owner/i.test(String(name || '')) ? 'owner' : 'company_driver'),
    },
  };

  const telegram = {
    async sendMessage(chatId, text) {
      sends.push({ chatId, text });
      return { message_id: sends.length };
    },
  };

  return { service: require(servicePath), telegram, sends, watermarks };
}

const SETTINGS = { enabled: true, road_allowance_weeks: 4, bonus_per_week: 100 };
const ROAD_START = '2026-01-01T00:00:00Z';

function companyRow(overrides = {}) {
  return {
    group_id: 1,
    telegram_group_id: '-1001',
    state: 'road',
    state_since: ROAD_START,
    road_bonus_weeks_notified: 0,
    group_name: 'WENZE UNIT # 2614 COMPANY DRIVER',
    first_name: 'Company',
    last_name: 'Driver',
    unit_number: '2614',
    driver_type: 'company_driver',
    ...overrides,
  };
}

test('no notification while within the road allowance', async () => {
  const { service, telegram, sends, watermarks } = loadService({ settings: SETTINGS, rows: [companyRow()] });
  // Day 28 = exactly the 4-week allowance, 0 full extra weeks.
  const res = await service.runRoadBonusCheck(telegram, { now: '2026-01-29T00:00:00Z' });
  assert.equal(sends.length, 0);
  assert.equal(watermarks.length, 0);
  assert.equal(res.notificationsSent, 0);
});

test('exactly one $100 notification the moment week 5 completes', async () => {
  const { service, telegram, sends, watermarks } = loadService({
    settings: SETTINGS, rows: [companyRow()],
  });
  // Day 35 = first full extra week completed (the 5th week on the road).
  const res = await service.runRoadBonusCheck(telegram, { now: '2026-02-05T00:00:00Z' });

  assert.equal(sends.length, 1);
  assert.equal(sends[0].chatId, BONUS_GROUP_ID);
  assert.match(sends[0].text, /\$100 bonus/);
  assert.match(sends[0].text, /week 5/);
  assert.equal(res.notificationsSent, 1);
  // Watermark advanced to 1.
  assert.deepEqual(watermarks, [{ groupId: 1, n: 1 }]);
});

test('multiple missed weeks are caught up in a single pass', async () => {
  const { service, telegram, sends, watermarks } = loadService({
    settings: SETTINGS, rows: [companyRow()],
  });
  // Day 49 = 3 full extra weeks (weeks 5, 6, 7). Nothing posted yet (watermark 0).
  const res = await service.runRoadBonusCheck(telegram, { now: '2026-02-19T00:00:00Z' });

  assert.equal(sends.length, 3);
  assert.match(sends[0].text, /week 5/);
  assert.match(sends[1].text, /week 6/);
  assert.match(sends[2].text, /week 7/);
  assert.equal(res.notificationsSent, 3);
  assert.deepEqual(watermarks, [{ groupId: 1, n: 3 }]);
});

test('idempotent: a repeat pass at the same time posts nothing new', async () => {
  const { service, telegram, sends } = loadService({
    settings: SETTINGS, rows: [companyRow({ road_bonus_weeks_notified: 3 })],
  });
  // Watermark already at 3; day 49 still = 3 extra weeks → nothing new.
  await service.runRoadBonusCheck(telegram, { now: '2026-02-19T00:00:00Z' });
  assert.equal(sends.length, 0);
});

test('idempotency across two consecutive passes (watermark persists in the row)', async () => {
  const { service, telegram, sends } = loadService({ settings: SETTINGS, rows: [companyRow()] });
  await service.runRoadBonusCheck(telegram, { now: '2026-02-05T00:00:00Z' }); // week 5 → 1 post
  await service.runRoadBonusCheck(telegram, { now: '2026-02-05T00:00:00Z' }); // same time → 0 new
  assert.equal(sends.length, 1);
});

test('owner-operators are never notified', async () => {
  const { service, telegram, sends, watermarks } = loadService({
    settings: SETTINGS,
    rows: [companyRow({
      group_id: 2,
      driver_type: 'owner',
      group_name: 'WENZE UNIT # 310 OWNER OPERATOR',
    })],
  });
  // Day 49 = 3 extra weeks, but owner-operators are out of scope.
  await service.runRoadBonusCheck(telegram, { now: '2026-02-19T00:00:00Z' });
  assert.equal(sends.length, 0);
  assert.equal(watermarks.length, 0);
});

test('owner-operator detected via group name when profile driver_type is missing', async () => {
  const { service, telegram, sends } = loadService({
    settings: SETTINGS,
    rows: [companyRow({
      group_id: 3,
      driver_type: null,
      group_name: 'WENZE UNIT # 77 OWNER OPERATOR',
    })],
  });
  await service.runRoadBonusCheck(telegram, { now: '2026-02-19T00:00:00Z' });
  assert.equal(sends.length, 0);
});

test('disabled settings short-circuit the whole pass', async () => {
  const { service, telegram, sends, watermarks } = loadService({
    settings: { enabled: false, road_allowance_weeks: 4, bonus_per_week: 100 },
    rows: [companyRow()],
  });
  const res = await service.runRoadBonusCheck(telegram, { now: '2026-02-19T00:00:00Z' });
  assert.equal(res.enabled, false);
  assert.equal(sends.length, 0);
  assert.equal(watermarks.length, 0);
});

test('respects a configurable allowance other than 4 weeks', async () => {
  const { service, telegram, sends } = loadService({
    settings: { enabled: true, road_allowance_weeks: 6, bonus_per_week: 100 },
    rows: [companyRow()],
  });
  // Day 49 = 7 weeks total, allowance 6 → exactly 1 extra week (week 7).
  await service.runRoadBonusCheck(telegram, { now: '2026-02-19T00:00:00Z' });
  assert.equal(sends.length, 1);
  assert.match(sends[0].text, /week 7/);
});

test('a failed send does not advance the watermark (weeks retried next pass)', async () => {
  const { service, watermarks } = loadService({ settings: SETTINGS, rows: [companyRow()] });
  const failing = { sendMessage: async () => { throw new Error('telegram down'); } };
  // Day 35 = 1 extra week; the send throws so the watermark must NOT advance.
  const res = await service.runRoadBonusCheck(failing, { now: '2026-02-05T00:00:00Z' });
  assert.equal(res.errors, 1);
  assert.equal(watermarks.length, 0);
});
