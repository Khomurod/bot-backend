const test = require('node:test');
const assert = require('node:assert/strict');
const {
  messageHasFuelHeader,
  extractStationFromText,
  isCompanyDriverProfile,
  detectStationFromMessage,
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
