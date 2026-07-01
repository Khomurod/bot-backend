const test = require('node:test');
const assert = require('node:assert/strict');
const {
  messageHasFuelHeader,
  extractStationFromText,
  isCompanyDriverProfile,
  detectStationFromMessage,
  computeNextCheck,
  reactToFuelMessage,
} = require('../services/fuelStopAlertService');

// Real fuel-monitoring instruction (screenshot 2). Always opens with the banner.
const FUEL_MESSAGE = [
  '⛽️FUEL MONITORING DEPARTMENT⛽️',
  '',
  'Good day!',
  'Please fuel up your truck at the following Fuel Station',
  '⛽ : Loves Travel Stop',
  '26530 Baker Rd, Perrysburg, OH, 43551',
  '🕐 Fuel level: 40%, 294 mi left till next station',
  '🔍 LINK : https://maps.app.goo.gl/WiNZiq4GrCvqkdrEA',
  "P.S. DO NOT USE DIFFERENT LOCATION, check the address and lemme know whether it's on your route or not",
].join('\n');

// Real load-location UPDATE messages (screenshot 1) — NOT fuel instructions,
// but they contain addresses + miles, which used to trigger a false positive.
const LOAD_UPDATE_BLOOMSBURG = [
  'Load # 9133928',
  'Status : Rolling',
  'CL:I-75, Riceville, TN 37370, USA',
  '674 miles left to DEL',
  'Autoneum Automotive North America, 480 W 5th St, Bloomsburg, PA 17815',
].join('\n');

const LOAD_UPDATE_KNOXVILLE = [
  'Load # 9133928',
  'Status : Rolling',
  'CL:1400 N 6th Ave Ste. D4, Knoxville, TN 37917, USA',
  '607 miles left to DEL',
  'Autoneum Automotive North America, 480 W 5th St, Bloomsburg, PA 17815, United States',
].join('\n');

test('messageHasFuelHeader is TRUE for genuine fuel instructions', () => {
  assert.equal(messageHasFuelHeader(FUEL_MESSAGE), true);
  assert.equal(messageHasFuelHeader('🛢 FUEL MONITORING DEPARTMENT 🛢\nPlease fuel up'), true);
  assert.equal(messageHasFuelHeader('🛑FUEL MONITORING DEPARTMENT🛑'), true);
  assert.equal(messageHasFuelHeader('fuel monitoring department\nsome body'), true);
  assert.equal(messageHasFuelHeader('   ⛽FUEL  MONITORING  DEPARTMENT⛽  '), true);
});

test('messageHasFuelHeader is FALSE for load updates and ordinary messages', () => {
  assert.equal(messageHasFuelHeader(LOAD_UPDATE_BLOOMSBURG), false);
  assert.equal(messageHasFuelHeader(LOAD_UPDATE_KNOXVILLE), false);
  assert.equal(messageHasFuelHeader('checking'), false);
  assert.equal(messageHasFuelHeader('good morning, delivering by noon'), false);
  // address only
  assert.equal(messageHasFuelHeader('480 W 5th St, Bloomsburg, PA 17815'), false);
  // maps link only
  assert.equal(messageHasFuelHeader('https://maps.app.goo.gl/WiNZiq4GrCvqkdrEA'), false);
  // station name mentioned but no banner
  assert.equal(messageHasFuelHeader('stop at Loves Travel Stop on your way'), false);
  // empty / nullish
  assert.equal(messageHasFuelHeader(''), false);
  assert.equal(messageHasFuelHeader(null), false);
  assert.equal(messageHasFuelHeader(undefined), false);
});

test('messageHasFuelHeader requires the banner on the FIRST non-empty line', () => {
  // Header buried after another line must NOT count ("starts with" rule).
  assert.equal(
    messageHasFuelHeader('checking\n⛽FUEL MONITORING DEPARTMENT⛽\n26530 Baker Rd, Perrysburg, OH'),
    false
  );
});

test('extractStationFromText pulls the street address from the banner body', () => {
  const { address } = extractStationFromText(FUEL_MESSAGE);
  assert.match(address, /26530 Baker Rd, Perrysburg, OH/);
});

test('detectStationFromMessage returns null for load updates (no geocode/AI)', async () => {
  assert.equal(await detectStationFromMessage({ message_id: 1, text: LOAD_UPDATE_BLOOMSBURG }), null);
  assert.equal(await detectStationFromMessage({ message_id: 2, text: LOAD_UPDATE_KNOXVILLE }), null);
});

test('detectStationFromMessage ignores location pins / venues without the banner', async () => {
  assert.equal(
    await detectStationFromMessage({ message_id: 3, location: { latitude: 40.36, longitude: -83.76 } }),
    null
  );
  assert.equal(
    await detectStationFromMessage({
      message_id: 4,
      venue: {
        title: "Love's Travel Stop",
        address: '26530 Baker Rd, Perrysburg, OH, 43551',
        location: { latitude: 40.36, longitude: -83.76 },
      },
    }),
    null
  );
});

test('detectStationFromMessage ignores plain chatter and empty messages', async () => {
  assert.equal(await detectStationFromMessage({ message_id: 5, text: 'checking' }), null);
  assert.equal(await detectStationFromMessage({ message_id: 6 }), null);
  assert.equal(await detectStationFromMessage(null), null);
});

test('isCompanyDriverProfile only accepts active company drivers', () => {
  assert.equal(isCompanyDriverProfile({ driver_type: 'company_driver', status: 'active' }), true);
  assert.equal(isCompanyDriverProfile({ driver_type: 'company_driver', status: undefined }), true);
  assert.equal(isCompanyDriverProfile({ driver_type: 'company_driver', status: 'inactive' }), false);
  assert.equal(isCompanyDriverProfile({ driver_type: 'owner', status: 'active' }), false);
  assert.equal(isCompanyDriverProfile(null), false);
  assert.equal(isCompanyDriverProfile({}), false);
});

const NOW = 1_700_000_000_000; // fixed epoch for deterministic scheduling tests
const MIN = 60_000;

test('computeNextCheck: already within radius → withinRadius', () => {
  assert.deepEqual(computeNextCheck({ distanceMiles: 9, radiusMiles: 10, speedMph: 55, nowMs: NOW }), { withinRadius: true });
  // exactly on the radius counts as within (not "beyond")
  assert.deepEqual(computeNextCheck({ distanceMiles: 10, radiusMiles: 10, speedMph: 55, nowMs: NOW }), { withinRadius: true });
});

test('computeNextCheck: default radius (no radiusMiles) is 50 miles', () => {
  // 45 mi out with no explicit radius → inside the new 50-mile default.
  assert.deepEqual(computeNextCheck({ distanceMiles: 45, speedMph: 55, nowMs: NOW }), { withinRadius: true });
  // 60 mi out → still approaching under the 50-mile default.
  assert.equal(computeNextCheck({ distanceMiles: 60, speedMph: 55, nowMs: NOW }).withinRadius, false);
});

test('computeNextCheck: far away wakes ~20 min before predicted arrival', () => {
  // 200 mi out, r=10 → 190 mi beyond, ×1.2 / 50 mph × 60 = 273.6 min to boundary.
  const r = computeNextCheck({ distanceMiles: 200, radiusMiles: 10, speedMph: 50, nowMs: NOW });
  assert.equal(r.withinRadius, false);
  assert.ok(Math.abs(r.minutesToBoundary - 273.6) < 0.01);
  // next check = ETA − 20 min
  const gapMin = (r.nextCheckAtMs - NOW) / MIN;
  assert.ok(Math.abs(gapMin - (273.6 - 20)) < 0.01, `gap was ${gapMin}`);
  assert.ok(Math.abs((r.etaBoundaryAtMs - NOW) / MIN - 273.6) < 0.01);
});

test('computeNextCheck: near the boundary polls tightly (~3 min)', () => {
  // 12 mi out, r=10 → 2 mi beyond → ~2.9 min → tight polling gap.
  const r = computeNextCheck({ distanceMiles: 12, radiusMiles: 10, speedMph: 50, nowMs: NOW });
  assert.equal(r.withinRadius, false);
  assert.equal((r.nextCheckAtMs - NOW) / MIN, 3);
});

test('computeNextCheck: missing/zero speed falls back to 50 mph', () => {
  const a = computeNextCheck({ distanceMiles: 60, radiusMiles: 10, speedMph: 0, nowMs: NOW });
  const b = computeNextCheck({ distanceMiles: 60, radiusMiles: 10, speedMph: undefined, nowMs: NOW });
  // 50 mi beyond ×1.2 / 50 × 60 = 72 min
  assert.ok(Math.abs(a.minutesToBoundary - 72) < 0.01);
  assert.deepEqual(a, b);
});

test('computeNextCheck: absurd speed is clamped to 75 mph', () => {
  const r = computeNextCheck({ distanceMiles: 85, radiusMiles: 10, speedMph: 500, nowMs: NOW });
  // 75 mi beyond ×1.2 / 75 × 60 = 72 min (clamped speed)
  assert.ok(Math.abs(r.minutesToBoundary - 72) < 0.01);
});

test('computeNextCheck: next check never sooner than 2 min or longer than 6h', () => {
  // Extremely far → capped at 6h.
  const far = computeNextCheck({ distanceMiles: 5000, radiusMiles: 10, speedMph: 50, nowMs: NOW });
  assert.equal((far.nextCheckAtMs - NOW) / MIN, 360);
});

// ─── reactToFuelMessage ────────────────────────────────────────────────────

test('reactToFuelMessage calls setMessageReaction when available', async () => {
  const calls = [];
  const telegram = {
    setMessageReaction: async (chatId, messageId, reaction) => {
      calls.push({ chatId, messageId, reaction });
    },
  };
  await reactToFuelMessage(telegram, -100123, 42);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].chatId, -100123);
  assert.equal(calls[0].messageId, 42);
  assert.deepEqual(calls[0].reaction, [{ type: 'emoji', emoji: '👍' }]);
});

test('reactToFuelMessage falls back to callApi when setMessageReaction is absent', async () => {
  const calls = [];
  const telegram = {
    callApi: async (method, params) => {
      calls.push({ method, params });
    },
  };
  await reactToFuelMessage(telegram, -100456, 99);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'setMessageReaction');
  assert.equal(calls[0].params.chat_id, -100456);
  assert.equal(calls[0].params.message_id, 99);
  assert.deepEqual(calls[0].params.reaction, [{ type: 'emoji', emoji: '👍' }]);
});

test('reactToFuelMessage never throws when the telegram call rejects', async () => {
  const telegram = {
    setMessageReaction: async () => { throw new Error('Forbidden'); },
  };
  // Must not throw
  await reactToFuelMessage(telegram, -100789, 7);
});

test('reactToFuelMessage is a no-op for missing telegram/chatId/messageId', async () => {
  // None of these should throw
  await reactToFuelMessage(null, -100, 1);
  await reactToFuelMessage({ setMessageReaction: async () => {} }, null, 1);
  await reactToFuelMessage({ setMessageReaction: async () => {} }, -100, null);
});

test('reactToFuelMessage supports a custom emoji', async () => {
  const calls = [];
  const telegram = {
    setMessageReaction: async (chatId, messageId, reaction) => { calls.push(reaction); },
  };
  await reactToFuelMessage(telegram, -1, 1, '✅');
  assert.deepEqual(calls[0], [{ type: 'emoji', emoji: '✅' }]);
});
