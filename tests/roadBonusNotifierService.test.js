const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROAD_BONUS_GROUP_ID = '-55555';
const OLD_HARDCODED_BONUS_GROUP = '-5170359585';

/**
 * Load roadBonusNotifierService with DB / telegram / message-routing deps mocked
 * via require.cache injection. The road bonus is now posted as ONE summary per
 * completed road leg (driver_road_history row), idempotent via an atomic
 * bonus_posted_at claim — not week-by-week while the driver is on the road.
 */
function loadService({ settings, rows, groupId = ROAD_BONUS_GROUP_ID }) {
  const servicePath = path.resolve(__dirname, '../services/roadBonusNotifierService.js');
  const htPath = path.resolve(__dirname, '../database/homeTime.js');
  const htmlPath = path.resolve(__dirname, '../services/telegramHtml.js');
  const mgPath = path.resolve(__dirname, '../database/messageRoutingSettings.js');
  const parsePath = path.resolve(__dirname, '../services/driverProfileParse.js');

  for (const p of [servicePath, htPath, htmlPath, mgPath, parsePath]) delete require.cache[p];

  const sends = [];
  const claimed = [];
  const unclaimed = [];
  const rowsById = new Map(rows.map((r) => [r.id, { ...r }]));

  require.cache[htPath] = {
    exports: {
      async getHomeTimeSettings() { return settings; },
      async listUnpostedRoadBonuses() {
        return [...rowsById.values()].filter(
          (r) => Number(r.bonus_usd) > 0 && r.bonus_posted_at == null
        );
      },
      async claimRoadBonusPost(id) {
        const row = rowsById.get(id);
        if (!row || row.bonus_posted_at != null) return null; // already posted/claimed
        row.bonus_posted_at = new Date().toISOString();
        claimed.push(id);
        return { ...row };
      },
      async unclaimRoadBonusPost(id) {
        const row = rowsById.get(id);
        if (row) row.bonus_posted_at = null;
        unclaimed.push(id);
        return row || null;
      },
    },
  };
  require.cache[htmlPath] = { exports: { safeSend: async (fn) => fn() } };
  require.cache[mgPath] = {
    exports: {
      async getGroupId(category) { return category === 'roadBonus' ? (groupId || null) : null; },
      missingGroupMessage() { return 'Extra Week bonus group ID is not configured.'; },
    },
  };
  require.cache[parsePath] = {
    exports: {
      inferDriverType: (name) => (/owner/i.test(String(name || '')) ? 'owner' : 'company_driver'),
    },
  };

  const telegram = {
    async sendMessage(chatId, text) { sends.push({ chatId, text }); return { message_id: sends.length }; },
  };

  return {
    service: require(servicePath), telegram, sends, claimed, unclaimed, rowsById,
  };
}

const SETTINGS = { enabled: true, road_allowance_weeks: 4, bonus_per_week: 100 };

// A completed road leg (driver_road_history row) as listUnpostedRoadBonuses returns it.
function legRow(overrides = {}) {
  return {
    id: 1,
    group_id: 1,
    driver_name: 'Company Driver',
    unit_number: '2614',
    days_on_road: 42, // 6 weeks
    exceeded_weeks: 2, // 2 full weeks beyond the 4-week allowance
    bonus_usd: 200, // 2 × $100
    bonus_posted_at: null,
    group_name: 'WENZE UNIT # 2614 COMPANY DRIVER',
    driver_type: 'company_driver',
    ...overrides,
  };
}

test('no message is posted while the driver is still on the road (no completed leg)', async () => {
  // A driver still out has no completed history row → nothing to post.
  const { service, telegram, sends } = loadService({ settings: SETTINGS, rows: [] });
  const res = await service.runRoadBonusCheck(telegram);
  assert.equal(sends.length, 0);
  assert.equal(res.notificationsSent, 0);
});

test('one summary is posted when a road leg completes over the allowance', async () => {
  const {
    service, telegram, sends, claimed,
  } = loadService({ settings: SETTINGS, rows: [legRow()] });
  const res = await service.runRoadBonusCheck(telegram);

  assert.equal(sends.length, 1);
  assert.equal(res.notificationsSent, 1);
  assert.deepEqual(claimed, [1]);
  // Company bonus calculated correctly: 2 extra weeks, $200 total, 6 weeks out.
  assert.match(sends[0].text, /2 extra weeks/);
  assert.match(sends[0].text, /\$200/);
  assert.match(sends[0].text, /6 week/);
});

test('the summary goes to the configured Extra Week / Road Bonus group ID', async () => {
  const { service, telegram, sends } = loadService({ settings: SETTINGS, rows: [legRow()] });
  await service.runRoadBonusCheck(telegram);
  assert.equal(sends[0].chatId, ROAD_BONUS_GROUP_ID);
  assert.notEqual(String(sends[0].chatId), OLD_HARDCODED_BONUS_GROUP);
});

test('no duplicate message for the same completed leg across repeated passes', async () => {
  const { service, telegram, sends } = loadService({ settings: SETTINGS, rows: [legRow()] });
  await service.runRoadBonusCheck(telegram); // posts once, stamps bonus_posted_at
  await service.runRoadBonusCheck(telegram); // leg already posted → nothing new
  assert.equal(sends.length, 1);
});

test('owner-operator leg (bonus 0) is never posted', async () => {
  const { service, telegram, sends } = loadService({
    settings: SETTINGS,
    rows: [legRow({
      id: 2, driver_type: 'owner', bonus_usd: 0, exceeded_weeks: 2,
      group_name: 'WENZE UNIT # 310 OWNER OPERATOR',
    })],
  });
  const res = await service.runRoadBonusCheck(telegram);
  assert.equal(sends.length, 0);
  assert.equal(res.notificationsSent, 0);
});

test('postCompletedRoadLeg refuses an owner-operator even if a bonus slipped through', async () => {
  const { service, telegram, sends } = loadService({ settings: SETTINGS, rows: [legRow()] });
  const result = await service.postCompletedRoadLeg(
    telegram,
    { ...legRow({ id: 9, driver_type: 'owner', bonus_usd: 200 }) },
    { allowanceWeeks: 4 }
  );
  assert.equal(result.posted, false);
  assert.equal(result.reason, 'owner_operator');
  assert.equal(sends.length, 0);
});

test('missing Extra Week group ID prevents sending and leaves the leg unposted', async () => {
  const {
    service, telegram, sends, claimed, rowsById,
  } = loadService({ settings: SETTINGS, rows: [legRow()], groupId: null });
  const res = await service.runRoadBonusCheck(telegram);
  assert.equal(sends.length, 0);
  assert.equal(res.notificationsSent, 0);
  assert.equal(claimed.length, 0); // not claimed → retried once configured
  assert.equal(rowsById.get(1).bonus_posted_at, null);
});

test('a failed send releases the claim so the leg is retried next pass', async () => {
  const { service, unclaimed, rowsById } = loadService({ settings: SETTINGS, rows: [legRow()] });
  const failing = { sendMessage: async () => { throw new Error('telegram down'); } };
  const res = await service.runRoadBonusCheck(failing);
  assert.equal(res.errors, 1);
  assert.deepEqual(unclaimed, [1]);
  assert.equal(rowsById.get(1).bonus_posted_at, null);
});

test('disabled home-time settings short-circuit the whole pass', async () => {
  const { service, telegram, sends } = loadService({
    settings: { enabled: false, road_allowance_weeks: 4, bonus_per_week: 100 },
    rows: [legRow()],
  });
  const res = await service.runRoadBonusCheck(telegram);
  assert.equal(res.enabled, false);
  assert.equal(sends.length, 0);
});
