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
  const parsePath = path.resolve(__dirname, '../lib/drivers/driverProfileParse.js');

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
            && ['released', 'forfeited'].includes(r.bonus_decision)
        );
      },
      async listRoadBonusesAwaitingDecision() {
        return [...rowsById.values()].filter(
          (r) => r.bonus_decision === 'waiting_home_stay' && r.bonus_posted_at == null
            && r.return_to_road_at != null
        );
      },
      async setRoadBonusDecision(id, { from, to, reason }) {
        const row = rowsById.get(id);
        if (!row || row.bonus_decision !== from || row.bonus_posted_at != null) return null;
        Object.assign(row, { bonus_decision: to, bonus_decision_reason: reason });
        return { ...row };
      },
      async claimRoadBonusPost(id) {
        const row = rowsById.get(id);
        if (!row || row.bonus_posted_at != null) return null; // already posted/claimed
        if (!['released', 'forfeited'].includes(row.bonus_decision)) return null;
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
    bonus_decision: 'released',
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
    // A LEGACY, undecided leg: the only kind whose type is still re-checked.
    { ...legRow({ id: 9, driver_type: 'owner', bonus_usd: 200, bonus_decision: null }) },
    { allowanceWeeks: 4 }
  );
  assert.equal(result.posted, false);
  assert.equal(result.reason, 'owner_operator');
  assert.equal(sends.length, 0);
});

test('a DECIDED bonus is posted even if the chat now belongs to an owner-operator (review, #260)', async () => {
  // Earned by a company driver, decided days later — by which time the chat may
  // have been reassigned. Re-reading the type then would drop it for ever.
  const { service, telegram, sends } = loadService({
    settings: SETTINGS, rows: [legRow({ driver_type: 'owner', group_name: 'WENZE UNIT # 310 OWNER OPERATOR' })],
  });
  await service.runRoadBonusCheck(telegram);
  assert.equal(sends.length, 1);
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

// ── what the run ledger is told ────────────────────────────────────────────

/**
 * SWITCHED OFF IS NOT HEALTHY AND IT IS NOT BROKEN.
 *
 * `statusFromSummary` reads `blocked`. Without it this pass returned a plain
 * summary with `enabled: false` and the ledger recorded a clean run, so a Home
 * Time feature nobody has switched on looked exactly like one posting bonuses
 * every week — the "configured versus working" conflation this whole layer
 * exists to remove.
 */
test('Home Time switched off is BLOCKED in the ledger, not a healthy pass', async () => {
  const { service, telegram } = loadService({ settings: { enabled: false }, rows: [] });
  const res = await service.runRoadBonusCheck(telegram);
  assert.equal(res.enabled, false);
  assert.match(res.blocked, /switched off/);
});

/** And every leg failing is the pass not having run. */
test('every leg failing to post is a FAILED pass, not a quiet one', async () => {
  const { service, sends } = loadService({ settings: SETTINGS, rows: [legRow(), legRow({ id: 2 })] });
  const telegram = { async sendMessage() { throw new Error('chat not found'); } };
  const res = await service.runRoadBonusCheck(telegram);
  assert.equal(sends.length, 0);
  assert.equal(res.errors, 2);
  assert.match(res.error, /none of the 2 completed leg\(s\) could be posted/,
    '`error` singular is the field the ledger reads; `errors` is a number nothing sees');
});

/** One failure among two is a leg to look at, not a failed pass. */
test('one leg failing among two leaves the pass healthy', async () => {
  const { service } = loadService({ settings: SETTINGS, rows: [legRow(), legRow({ id: 2 })] });
  let first = true;
  const telegram = {
    async sendMessage() {
      if (first) { first = false; throw new Error('chat not found'); }
      return { message_id: 1 };
    },
  };
  const res = await service.runRoadBonusCheck(telegram);
  assert.equal(res.errors, 1);
  assert.equal(res.error, undefined);
});

// ── decided after the home stay (owner's rule, 2026-10-06) ──────────────────

const SETTINGS_4D = { ...SETTINGS, home_allowance_days: 4 };
const backOnRoad = (over = {}) => legRow({
  bonus_decision: 'waiting_home_stay', return_to_road_at: '2026-10-05T12:00:00Z', home_days: 3, ...over,
});

test('a driver still at home: nothing is decided and nothing is posted', async () => {
  const { service, telegram, sends, rowsById } = loadService({
    settings: SETTINGS_4D, rows: [backOnRoad({ return_to_road_at: null, home_days: null })],
  });
  await service.runRoadBonusCheck(telegram);
  assert.equal(sends.length, 0);
  assert.equal(rowsById.get(1).bonus_decision, 'waiting_home_stay');
});

test('back on the road within the home allowance: released and the summary is posted', async () => {
  const { service, telegram, sends, rowsById } = loadService({ settings: SETTINGS_4D, rows: [backOnRoad()] });
  const res = await service.runRoadBonusCheck(telegram);
  assert.equal(rowsById.get(1).bonus_decision, 'released');
  assert.equal(res.decided.released, 1);
  assert.equal(sends.length, 1);
  assert.match(sends[0].text, /road bonus/);
  assert.match(sends[0].text, /\$200/);
  assert.match(sends[0].text, /Home 3 day/);
  assert.doesNotMatch(sends[0].text, /is home/, 'it is posted after the driver has LEFT home');
});

test('exactly the allowance is still within it', async () => {
  const { service, telegram, rowsById } = loadService({ settings: SETTINGS_4D, rows: [backOnRoad({ home_days: 4 })] });
  await service.runRoadBonusCheck(telegram);
  assert.equal(rowsById.get(1).bonus_decision, 'released');
});

test('home LONGER than the allowance: no bonus, and one note says why', async () => {
  const { service, telegram, sends, rowsById } = loadService({
    settings: SETTINGS_4D, rows: [backOnRoad({ home_days: 6 })],
  });
  const res = await service.runRoadBonusCheck(telegram);
  assert.equal(rowsById.get(1).bonus_decision, 'forfeited');
  assert.equal(res.decided.forfeited, 1);
  assert.equal(sends.length, 1);
  assert.match(sends[0].text, /no road bonus/);
  assert.match(sends[0].text, /stayed home 6 days; the limit is 4 days/);
  assert.doesNotMatch(sends[0].text, /Needs a/, 'a forfeited bonus is never asked to be paid');
  await service.runRoadBonusCheck(telegram);
  assert.equal(sends.length, 1, 'said once');
});

test('a trip longer than six weeks is HELD for a person and not posted', async () => {
  const { service, telegram, sends, rowsById } = loadService({
    settings: SETTINGS_4D, rows: [backOnRoad({ days_on_road: 117, exceeded_weeks: 12, bonus_usd: 1200 })],
  });
  const res = await service.runRoadBonusCheck(telegram);
  assert.equal(rowsById.get(1).bonus_decision, 'needs_review');
  assert.equal(res.decided.needsReview, 1);
  assert.equal(sends.length, 0);
  await service.runRoadBonusCheck(telegram);
  assert.equal(sends.length, 0, 'held means held, every pass, until a person releases it');
});

test('a leg a person already approved is never re-decided', async () => {
  const { service, telegram, rowsById } = loadService({
    settings: SETTINGS_4D, rows: [backOnRoad({ bonus_decision: 'released', days_on_road: 117 })],
  });
  await service.runRoadBonusCheck(telegram);
  assert.equal(rowsById.get(1).bonus_decision, 'released');
});
