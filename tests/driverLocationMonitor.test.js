const test = require('node:test');
const assert = require('node:assert/strict');

// config.js validates required secrets at require time; provide harmless values
// so requiring the service (transitively) does not exit the test process.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@127.0.0.1:5432/db';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.BOT_TOKEN = process.env.BOT_TOKEN || '1:test';
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '2:test';
process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY = process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY
  || '0123456789abcdef0123456789abcdef';

const {
  heuristicPhase,
  phaseToStopType,
  nextCheckMinutes,
} = require('../services/driverLocationMonitorService');
const {
  normalizeNameForMatch,
  orderDriverCandidates,
} = require('../services/datatruckApiService');

test('heuristicPhase heads to pickup while the pickup appointment is still ahead', () => {
  const now = Date.now();
  assert.equal(
    heuristicPhase({
      pickupTime: new Date(now + 3600_000).toISOString(),
      deliveryTime: new Date(now + 7200_000).toISOString(),
      nowMs: now,
    }),
    'heading_pickup'
  );
});

test('heuristicPhase switches to delivery once the pickup is well in the past', () => {
  const now = Date.now();
  assert.equal(
    heuristicPhase({
      pickupTime: new Date(now - 7200_000).toISOString(),
      deliveryTime: new Date(now + 7200_000).toISOString(),
      nowMs: now,
    }),
    'heading_delivery'
  );
});

test('heuristicPhase falls back to delivery when only a delivery time is known', () => {
  const now = Date.now();
  assert.equal(
    heuristicPhase({ pickupTime: '', deliveryTime: new Date(now + 7200_000).toISOString(), nowMs: now }),
    'heading_delivery'
  );
});

test('heuristicPhase honors a small grace window around the pickup appointment', () => {
  const now = Date.now();
  // Pickup 5 minutes ago is still within the on-time grace → keep heading to pickup.
  assert.equal(
    heuristicPhase({ pickupTime: new Date(now - 5 * 60_000).toISOString(), deliveryTime: '', nowMs: now }),
    'heading_pickup'
  );
});

test('phaseToStopType maps phases to shipper/receiver', () => {
  assert.equal(phaseToStopType('heading_pickup'), 'shipper');
  assert.equal(phaseToStopType('heading_delivery'), 'receiver');
});

test('nextCheckMinutes tightens as ETA shrinks and respects the interval cap', () => {
  assert.equal(nextCheckMinutes({ etaMinutes: 60, intervalCap: 30 }), 20); // far → loose
  assert.equal(nextCheckMinutes({ etaMinutes: 15, intervalCap: 30 }), 5);
  assert.equal(nextCheckMinutes({ etaMinutes: 6, intervalCap: 30 }), 2);   // close → tight
  assert.equal(nextCheckMinutes({ etaMinutes: 600, intervalCap: 30 }), 30); // never exceed cap
  assert.equal(nextCheckMinutes({ etaMinutes: 1, intervalCap: 30 }), 2);    // never below floor
});

test('normalizeNameForMatch lowercases and strips punctuation/accents-as-symbols', () => {
  assert.equal(normalizeNameForMatch("  John   O'Brien-Smith "), 'john o brien smith');
  assert.equal(normalizeNameForMatch('JOHN  DOE'), 'john doe');
  assert.equal(normalizeNameForMatch(null), '');
});

test('orderDriverCandidates collects assigned and team drivers', () => {
  const order = {
    trip: { driver__full_name: 'John Doe', team_driver__full_name: 'Jane Roe' },
    assigned_driver: 'Backup Bob',
  };
  const candidates = orderDriverCandidates(order);
  assert.ok(candidates.includes('John Doe'));
  assert.ok(candidates.includes('Jane Roe'));
  assert.ok(candidates.includes('Backup Bob'));
});

test('orderDriverCandidates is safe on empty orders', () => {
  assert.deepEqual(orderDriverCandidates({}), []);
  assert.deepEqual(orderDriverCandidates({ trip: {} }), []);
});

// ─── One-prompt-per-stop dedup + Checked In/Out buttons ───

const path = require('node:path');

const SERVICE_PATH = path.resolve(__dirname, '../services/driverLocationMonitorService.js');
const DB_MONITORS_PATH = path.resolve(__dirname, '../database/driverLocationMonitors.js');
const DB_PATH = path.resolve(__dirname, '../database/db.js');
const DATATRUCK_API_PATH = path.resolve(__dirname, '../services/datatruckApiService.js');
const DATATRUCK_LOAD_PATH = path.resolve(__dirname, '../services/datatruckLoadService.js');
const LIVE_LOCATION_PATH = path.resolve(__dirname, '../services/liveLocationResolver.js');
const ETA_ROUTING_PATH = path.resolve(__dirname, '../services/etaRoutingService.js');
const PINNED_CTX_PATH = path.resolve(__dirname, '../services/dispatchPinnedContextService.js');
const MENTION_PATH = path.resolve(__dirname, '../services/telegramMention.js');
const GROUP_TITLE_PATH = path.resolve(__dirname, '../services/driverGroupTitle.js');
const GEMINI_PATH = path.resolve(__dirname, '../services/geminiClient.js');
const HANDLERS_PATH = path.resolve(__dirname, '../bot/locationCheckinHandlers.js');

// A default Datatruck load: pickup appointment in the future → heading to the
// shipper by the time heuristic.
function defaultLoad(overrides = {}) {
  const now = Date.now();
  return {
    orderId: 'ORD-1',
    pickupAddress: '100 Shipper St, Dallas, TX',
    deliveryAddress: '200 Receiver Ave, Memphis, TN',
    pickupTime: new Date(now + 3600_000).toISOString(),
    deliveryTime: new Date(now + 7200_000).toISOString(),
    shipperName: 'ACME',
    receiverName: 'BETA',
    ...overrides,
  };
}

function loadMonitorServiceWithMocks({ monitorsMock, load = defaultLoad(), etaMock } = {}) {
  for (const p of [
    SERVICE_PATH, DB_MONITORS_PATH, DB_PATH, DATATRUCK_API_PATH, DATATRUCK_LOAD_PATH,
    LIVE_LOCATION_PATH, ETA_ROUTING_PATH, PINNED_CTX_PATH, MENTION_PATH, GROUP_TITLE_PATH,
    GEMINI_PATH,
  ]) {
    delete require.cache[p];
  }

  require.cache[DB_PATH] = { id: DB_PATH, exports: { query: async () => ({ rows: [], rowCount: 0 }) } };
  require.cache[DB_MONITORS_PATH] = { id: DB_MONITORS_PATH, exports: monitorsMock };
  require.cache[DATATRUCK_API_PATH] = {
    id: DATATRUCK_API_PATH,
    exports: { isConfigured: () => true },
  };
  require.cache[DATATRUCK_LOAD_PATH] = {
    id: DATATRUCK_LOAD_PATH,
    exports: {
      extractStopsFromOrder: () => ({}),
      resolveActiveLoadForDriver: async () => load,
    },
  };
  require.cache[LIVE_LOCATION_PATH] = {
    id: LIVE_LOCATION_PATH,
    exports: {
      resolveLiveLocationForGroupTitle: async () => ({
        location: { latitude: 32.9, longitude: -96.9, address: '5 mi out, TX' },
        source: 'Test ELD',
      }),
    },
  };
  require.cache[ETA_ROUTING_PATH] = {
    id: ETA_ROUTING_PATH,
    exports: {
      calculateEtaToDestination: async () => (etaMock !== undefined ? etaMock : {
        remainingMiles: 3,
        etaMinutes: 6,
        destination: { latitude: 32.8, longitude: -96.8, displayName: 'Target' },
      }),
      geocodePlace: async () => null,
      haversineMiles: () => 3,
    },
  };
  require.cache[PINNED_CTX_PATH] = {
    id: PINNED_CTX_PATH,
    exports: { readLoadContextWithFallbacks: async () => { throw Object.assign(new Error('none'), { code: 'LOAD_CONTEXT_NOT_FOUND' }); } },
  };
  require.cache[MENTION_PATH] = {
    id: MENTION_PATH,
    exports: {
      buildMention: () => '@driver',
      createMentionResolver: () => ({ mentionForName: async () => '@driver', mentionForTelegramId: async () => '@driver' }),
    },
  };
  require.cache[GROUP_TITLE_PATH] = {
    id: GROUP_TITLE_PATH,
    exports: { extractDriverNameFromGroupTitle: () => 'John Doe' },
  };
  require.cache[GEMINI_PATH] = { id: GEMINI_PATH, exports: {} }; // no GEMINI_API_KEY → template/heuristic

  return require(SERVICE_PATH);
}

function makeJob(overrides = {}) {
  return {
    id: 1,
    group_id: 42,
    telegram_group_id: '-100999',
    group_name: 'WENZE UNIT # 07 John Doe',
    group_language: 'en',
    telegram_username: 'driverjohn',
    first_name: 'John',
    last_name: 'Doe',
    interval_minutes: 30,
    checkin_radius_miles: 8,
    active_checkin_id: null,
    load_phase: null,
    ...overrides,
  };
}

// Base monitors-db mock: nothing exists yet; records calls.
function makeMonitorsMock(overrides = {}) {
  const calls = { createCheckin: [], releaseMonitor: [], setCheckinPromptMessageId: [], hasCheckinForStop: [] };
  const base = {
    _calls: calls,
    hasCheckinForStop: async (args) => { calls.hasCheckinForStop.push(args); return false; },
    createCheckin: async (args) => { calls.createCheckin.push(args); return { id: 555, ...args }; },
    setCheckinPromptMessageId: async (id, m) => { calls.setCheckinPromptMessageId.push([id, m]); return null; },
    getCheckinById: async () => null,
    releaseMonitor: async (id, state) => { calls.releaseMonitor.push([id, state]); return { id, ...state }; },
    clearMonitorTarget: async () => null,
    recordCheckinResponse: async () => ({ record: {}, alreadyAnswered: false }),
  };
  return Object.assign(base, overrides);
}

function fakeTelegram(sentSink) {
  return {
    getChat: async () => ({ title: 'WENZE UNIT # 07 John Doe' }),
    sendMessage: async (chatId, text, opts) => {
      sentSink.push({ chatId, text, opts });
      return { message_id: 7001 };
    },
  };
}

test('within radius with no prior check-in → exactly ONE prompt with Checked In/Out buttons', async () => {
  const monitors = makeMonitorsMock();
  const service = loadMonitorServiceWithMocks({ monitorsMock: monitors });
  const sent = [];
  service.configureDriverLocationTelegram(fakeTelegram(sent));

  const result = await service.processMonitorJob(makeJob());

  assert.equal(result.reason, 'checkin_sent');
  assert.equal(monitors._calls.createCheckin.length, 1);
  assert.equal(monitors._calls.createCheckin[0].stopType, 'shipper');
  assert.equal(sent.length, 1);

  const kb = sent[0].opts.reply_markup.inline_keyboard[0];
  assert.equal(kb[0].text, '✅ Checked In');
  assert.equal(kb[1].text, '🚪 Checked Out');
  assert.equal(kb[0].callback_data, 'loccheck:in:555');
  assert.equal(kb[1].callback_data, 'loccheck:out:555');

  const [, state] = monitors._calls.releaseMonitor.at(-1);
  assert.equal(state.lastStatus, 'checkin_sent');
  assert.equal(state.activeCheckinId, 555);
});

test('second pass for the same (order, stop_type) → NO second prompt, even after an answer cleared active_checkin_id', async () => {
  const monitors = makeMonitorsMock({
    // Simulate the durable guard: a prior check-in already exists for this stop.
    hasCheckinForStop: async () => true,
  });
  const service = loadMonitorServiceWithMocks({ monitorsMock: monitors });
  const sent = [];
  service.configureDriverLocationTelegram(fakeTelegram(sent));

  const result = await service.processMonitorJob(makeJob({ active_checkin_id: null }));

  assert.equal(result.reason, 'already_prompted');
  assert.equal(monitors._calls.createCheckin.length, 0);
  assert.equal(sent.length, 0);
  const [, state] = monitors._calls.releaseMonitor.at(-1);
  assert.equal(state.lastStatus, 'already_prompted');
});

test('concurrent claim (unique-violation on insert) → still only one prompt', async () => {
  const monitors = makeMonitorsMock({
    hasCheckinForStop: async () => false, // race: guard passes...
    createCheckin: async () => ({ duplicate: true }), // ...but the unique index catches it
  });
  const service = loadMonitorServiceWithMocks({ monitorsMock: monitors });
  const sent = [];
  service.configureDriverLocationTelegram(fakeTelegram(sent));

  const result = await service.processMonitorJob(makeJob());

  assert.equal(result.reason, 'already_prompted');
  assert.equal(sent.length, 0);
});

test('shipper already prompted, truck heading to receiver → receiver gets its own single prompt', async () => {
  // Pickup appointment in the past → heuristic heads to delivery (receiver).
  const now = Date.now();
  const load = defaultLoad({
    pickupTime: new Date(now - 7200_000).toISOString(),
    deliveryTime: new Date(now + 3600_000).toISOString(),
  });
  const seen = [];
  const monitors = makeMonitorsMock({
    hasCheckinForStop: async (args) => { seen.push(args.stopType); return false; },
  });
  const service = loadMonitorServiceWithMocks({ monitorsMock: monitors, load });
  const sent = [];
  service.configureDriverLocationTelegram(fakeTelegram(sent));

  const result = await service.processMonitorJob(makeJob());

  assert.equal(result.reason, 'checkin_sent');
  assert.equal(monitors._calls.createCheckin.length, 1);
  assert.equal(monitors._calls.createCheckin[0].stopType, 'receiver');
  assert.deepEqual(seen, ['receiver']);
});

test('still far from the stop → tracking, no prompt', async () => {
  const monitors = makeMonitorsMock();
  const service = loadMonitorServiceWithMocks({
    monitorsMock: monitors,
    etaMock: { remainingMiles: 50, etaMinutes: 60, destination: { latitude: 1, longitude: 2 } },
  });
  const sent = [];
  service.configureDriverLocationTelegram(fakeTelegram(sent));

  const result = await service.processMonitorJob(makeJob());

  assert.equal(result.reason, 'tracking');
  assert.equal(monitors._calls.createCheckin.length, 0);
  assert.equal(sent.length, 0);
});

test('no active load → no prompt', async () => {
  const monitors = makeMonitorsMock();
  const service = loadMonitorServiceWithMocks({ monitorsMock: monitors, load: null });
  const sent = [];
  service.configureDriverLocationTelegram(fakeTelegram(sent));

  const result = await service.processMonitorJob(makeJob());

  assert.equal(result.reason, 'no_load');
  assert.equal(monitors._calls.createCheckin.length, 0);
  assert.equal(sent.length, 0);
});

// ─── DB dedupe-key helper ───

test('buildStopDedupeKey is stable per stop and distinguishes shipper/receiver and order/address', () => {
  delete require.cache[DB_PATH];
  delete require.cache[DB_MONITORS_PATH];
  require.cache[DB_PATH] = { id: DB_PATH, exports: { query: async () => ({ rows: [], rowCount: 0 }) } };
  const { buildStopDedupeKey } = require(DB_MONITORS_PATH);

  assert.equal(buildStopDedupeKey({ groupId: 42, orderId: 'ORD-1', stopType: 'shipper' }),
    buildStopDedupeKey({ groupId: 42, orderId: 'ORD-1', stopType: 'shipper' }));
  assert.notEqual(buildStopDedupeKey({ groupId: 42, orderId: 'ORD-1', stopType: 'shipper' }),
    buildStopDedupeKey({ groupId: 42, orderId: 'ORD-1', stopType: 'receiver' }));
  // null-order fallback loads dedupe on the normalized address instead.
  const a = buildStopDedupeKey({ groupId: 42, orderId: null, stopType: 'shipper', targetAddress: '  100 Main   ST ' });
  const b = buildStopDedupeKey({ groupId: 42, orderId: null, stopType: 'shipper', targetAddress: '100 main st' });
  assert.equal(a, b);
  assert.ok(a.includes('g42'));
});

// ─── Answer handler (two-phase: Checked In on arrival → Checked Out on departure) ───

const BOT_USERS_PATH = path.resolve(__dirname, '../database/botUsers.js');

function loadHandlersWithMocks(monitorsMock, botUsersMock) {
  delete require.cache[HANDLERS_PATH];
  delete require.cache[DB_MONITORS_PATH];
  delete require.cache[BOT_USERS_PATH];
  delete require.cache[DB_PATH];
  require.cache[DB_PATH] = { id: DB_PATH, exports: { query: async () => ({ rows: [], rowCount: 0 }) } };
  require.cache[DB_MONITORS_PATH] = { id: DB_MONITORS_PATH, exports: monitorsMock };
  require.cache[BOT_USERS_PATH] = { id: BOT_USERS_PATH, exports: botUsersMock };
  return require(HANDLERS_PATH);
}

function registerAndGetAction(handlers) {
  let actionFn = null;
  let actionRe = null;
  const bot = { action: (re, fn) => { actionRe = re; actionFn = fn; } };
  handlers.registerLocationCheckinHandlers(bot);
  return { actionFn, actionRe };
}

function makeCtx(action, checkinId, edited) {
  return {
    match: [`loccheck:${action}:${checkinId}`, action, String(checkinId)],
    from: { id: 123, username: 'driverjohn', first_name: 'John', last_name: 'Doe' },
    callbackQuery: { message: { chat: { id: -100999 }, message_id: 7001, text: 'prompt body' } },
    editMessageText: async (t, extra) => { edited.text = t; edited.extra = extra; },
    editMessageReplyMarkup: async (markup) => { edited.replacedMarkup = markup ?? null; },
    answerCbQuery: async (t) => { edited.cbq = t; },
  };
}

// Shared harness: run one tap against a check-in row in the given status.
async function runHandlerTap(action, { checkinStatus = 'awaiting_response', dwellMinutes = null } = {}) {
  const calls = { clearMonitorTarget: [], releaseMonitor: [], arrivals: [], departures: [], userTaps: [] };
  const monitors = {
    getCheckinById: async () => ({
      id: 555, monitor_id: 9, group_id: 42, stop_type: 'shipper', telegram_group_id: -100999,
      prompt_message_id: 7001, appointment_at: null, status: checkinStatus,
    }),
    recordCheckinArrival: async (id, args) => {
      calls.arrivals.push([id, args]);
      if (checkinStatus !== 'awaiting_response') {
        return { record: { id, status: checkinStatus, checked_in_by_username: 'someoneelse' }, alreadyDone: true };
      }
      return { record: { id, status: 'checked_in', driver_response: 'checked_in' }, alreadyDone: false };
    },
    recordCheckinDeparture: async (id, args) => {
      calls.departures.push([id, args]);
      if (checkinStatus === 'completed') {
        return { record: { id, status: 'completed', checked_out_by_username: 'someoneelse' }, alreadyDone: true };
      }
      return {
        record: { id, status: 'completed', driver_response: 'checked_out', dwell_minutes: dwellMinutes },
        alreadyDone: false,
      };
    },
    clearMonitorTarget: async (id, args) => { calls.clearMonitorTarget.push([id, args]); return {}; },
    releaseMonitor: async (id, args) => { calls.releaseMonitor.push([id, args]); return {}; },
  };
  const botUsers = {
    recordBotUserInteraction: async (args) => { calls.userTaps.push(args); return args; },
  };
  const handlers = loadHandlersWithMocks(monitors, botUsers);
  const { actionFn, actionRe } = registerAndGetAction(handlers);
  assert.equal(actionRe.test(`loccheck:${action}:555`), true);
  assert.equal(actionRe.test('loccheck:yes:555'), false); // old callbacks no longer match
  const edited = {};
  await actionFn(makeCtx(action, 555, edited));
  return { calls, edited };
}

test('handler: "Checked In" records arrival, keeps ONLY the Checked Out button, and advances the monitor', async () => {
  const { calls, edited } = await runHandlerTap('in');

  assert.equal(calls.arrivals.length, 1);
  assert.equal(calls.arrivals[0][1].username, 'driverjohn');
  assert.equal(calls.arrivals[0][1].userId, 123);

  // The message is edited to show the check-in footer with just Checked Out left.
  assert.match(edited.text, /Checked in at the shipper/);
  const buttons = edited.extra?.reply_markup?.inline_keyboard?.flat() || [];
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].text, '🚪 Checked Out');
  assert.equal(buttons[0].callback_data, 'loccheck:out:555');

  // Monitor advances to the next stop; no re-prompt scheduling for this one.
  assert.equal(calls.clearMonitorTarget.length, 1);
  assert.equal(calls.clearMonitorTarget[0][1].lastStatus, 'checked_in_shipper');
  assert.equal(calls.releaseMonitor.length, 0);
});

test('handler: "Checked Out" after check-in records departure with dwell and removes the keyboard', async () => {
  const { calls, edited } = await runHandlerTap('out', { checkinStatus: 'checked_in', dwellMinutes: 135 });

  assert.equal(calls.departures.length, 1);
  assert.equal(calls.departures[0][1].username, 'driverjohn');
  assert.equal(calls.departures[0][1].userId, 123);

  // Footer reports the stay length; no keyboard remains on the message.
  assert.match(edited.text, /Checked out of the shipper/);
  assert.match(edited.text, /stayed 2h 15m/);
  assert.equal(edited.extra, undefined);

  // The monitor already advanced at check-in — checkout must not reset it.
  assert.equal(calls.clearMonitorTarget.length, 0);
  assert.equal(calls.releaseMonitor.length, 0);
});

test('handler: "Checked Out" straight from the prompt (skipped arrival) completes and advances the monitor', async () => {
  const { calls, edited } = await runHandlerTap('out', { checkinStatus: 'awaiting_response' });

  assert.equal(calls.departures.length, 1);
  assert.match(edited.text, /Checked out of the shipper/);
  assert.doesNotMatch(edited.text, /stayed/); // no dwell without an arrival tap
  assert.equal(calls.clearMonitorTarget.length, 1);
  assert.equal(calls.clearMonitorTarget[0][1].lastStatus, 'checked_out_shipper');
});

test('handler: every tap saves the user (username + user id) for the admin Users tab', async () => {
  const inTap = await runHandlerTap('in');
  assert.equal(inTap.calls.userTaps.length, 1);
  assert.deepEqual(inTap.calls.userTaps[0], {
    telegramUserId: 123,
    username: 'driverjohn',
    firstName: 'John',
    lastName: 'Doe',
    action: 'loccheck:in',
    groupId: 42,
  });

  const outTap = await runHandlerTap('out', { checkinStatus: 'checked_in' });
  assert.equal(outTap.calls.userTaps.length, 1);
  assert.equal(outTap.calls.userTaps[0].action, 'loccheck:out');
});

test('handler: duplicate taps are idempotent and never re-prompt', async () => {
  // Second "in" tap on an already-checked-in row → toast only, no state changes.
  const dupIn = await runHandlerTap('in', { checkinStatus: 'checked_in' });
  assert.match(dupIn.edited.cbq, /Already checked in/);
  assert.equal(dupIn.edited.text, undefined);
  assert.equal(dupIn.calls.clearMonitorTarget.length, 0);

  // Second "out" tap on a completed row → toast only.
  const dupOut = await runHandlerTap('out', { checkinStatus: 'completed' });
  assert.match(dupOut.edited.cbq, /Already checked out/);
  assert.equal(dupOut.edited.text, undefined);
  assert.equal(dupOut.calls.clearMonitorTarget.length, 0);
});

test('formatDwell renders minutes as h/m labels', () => {
  delete require.cache[HANDLERS_PATH];
  delete require.cache[DB_MONITORS_PATH];
  delete require.cache[BOT_USERS_PATH];
  delete require.cache[DB_PATH];
  require.cache[DB_PATH] = { id: DB_PATH, exports: { query: async () => ({ rows: [], rowCount: 0 }) } };
  require.cache[DB_MONITORS_PATH] = { id: DB_MONITORS_PATH, exports: {} };
  require.cache[BOT_USERS_PATH] = { id: BOT_USERS_PATH, exports: {} };
  const { formatDwell } = require(HANDLERS_PATH);
  assert.equal(formatDwell(135), '2h 15m');
  assert.equal(formatDwell(45), '45m');
  assert.equal(formatDwell(0), '0m');
  assert.equal(formatDwell(null), null);
  assert.equal(formatDwell(-5), null);
});
