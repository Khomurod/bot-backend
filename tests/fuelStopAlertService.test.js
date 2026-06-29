const test = require('node:test');
const assert = require('node:assert/strict');
const { detectStationFromMessage } = require('../services/fuelStopAlertService');

// These cases all resolve without any network/AI call: a location pin and a
// venue carry coordinates directly, and a message with no fuel signal is
// rejected by the cheap pre-filter before any AI/geocode work.

test('detectStationFromMessage reads a Telegram location pin directly', async () => {
  const station = await detectStationFromMessage({
    message_id: 1,
    location: { latitude: 40.36, longitude: -83.76 },
  });
  assert.ok(station);
  assert.equal(station.latitude, 40.36);
  assert.equal(station.longitude, -83.76);
});

test('detectStationFromMessage reads a venue (name + address + coords)', async () => {
  const station = await detectStationFromMessage({
    message_id: 2,
    venue: {
      title: "Love's Travel Stop",
      address: '2001 State Route 540, Bellefontaine, OH',
      location: { latitude: 40.36, longitude: -83.76 },
    },
  });
  assert.ok(station);
  assert.equal(station.stationName, "Love's Travel Stop");
  assert.equal(station.stationAddress, '2001 State Route 540, Bellefontaine, OH');
  assert.equal(station.latitude, 40.36);
});

test('detectStationFromMessage ignores ordinary chatter (no fuel signal)', async () => {
  const station = await detectStationFromMessage({
    message_id: 3,
    text: 'good morning, running on time, should deliver by noon',
  });
  assert.equal(station, null);
});

test('detectStationFromMessage ignores empty messages', async () => {
  assert.equal(await detectStationFromMessage({ message_id: 4 }), null);
  assert.equal(await detectStationFromMessage(null), null);
});
