/**
 * Destination auto-completion — the pure radius/staleness decision
 * (evaluateDestinationCompletion) and its behavior inside a monitor pass:
 * silent completion, the atomic no-double-complete guarantee, and the fact that
 * off-route warnings still work outside the radius.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { POLYLINE, NOW, offRoute } = require('./helpers/routeControlHarness');
const {
  evaluateDestinationCompletion, M_PER_MILE, DEST, pointMilesFromDest, COMPLETION_SETTINGS,
  completion, loadServiceForCompletion, NEAR_DEST_OFF_ROUTE,
} = require('./helpers/routeControlCompletionHarness');

test('evaluateDestinationCompletion: 5 miles from destination → complete', () => {
  const v = completion(pointMilesFromDest(5));
  assert.equal(v.shouldComplete, true);
  assert.ok(Math.abs(v.distanceMiles - 5) < 0.01);
});

test('evaluateDestinationCompletion: 20 miles → complete', () => {
  assert.equal(completion(pointMilesFromDest(20)).shouldComplete, true);
});

test('evaluateDestinationCompletion: 49.9 miles → complete (just inside)', () => {
  assert.equal(completion(pointMilesFromDest(49.9)).shouldComplete, true);
});

test('evaluateDestinationCompletion: exactly 50 miles → complete (inclusive boundary)', () => {
  const v = completion(pointMilesFromDest(50));
  assert.equal(v.shouldComplete, true);
  assert.ok(Math.abs(v.distanceMiles - 50) < 0.001);
});

test('evaluateDestinationCompletion: 50.1 miles → NOT complete (just outside)', () => {
  const v = completion(pointMilesFromDest(50.1));
  assert.equal(v.shouldComplete, false);
  assert.equal(v.code, 'OUTSIDE_COMPLETION_RADIUS');
});

test('evaluateDestinationCompletion: 60 miles → NOT complete, monitoring continues', () => {
  assert.equal(completion(pointMilesFromDest(60)).shouldComplete, false);
});

test('evaluateDestinationCompletion: the authoritative DEFAULT radius is 50 miles', () => {
  // No completionRadiusMiles passed at all → the constants default applies.
  const inside = completion(pointMilesFromDest(45), {}, { staleGpsMinutes: 15, completionRadiusMiles: undefined });
  assert.equal(inside.shouldComplete, true, '45 mi completes under the 50 mi default');
  const outside = completion(pointMilesFromDest(51), {}, { staleGpsMinutes: 15, completionRadiusMiles: undefined });
  assert.equal(outside.shouldComplete, false, '51 mi does not complete under the 50 mi default');
});

test('evaluateDestinationCompletion: numeric coordinate STRINGS are normalized', () => {
  const v = completion(
    { latitude: String(pointMilesFromDest(5).latitude), longitude: '-100', speedMilesPerHour: 55, pingAgeMinutes: 1 },
    { destination_lat: '40', destination_lng: '-100' }
  );
  assert.equal(v.shouldComplete, true);
});

test('evaluateDestinationCompletion: stale GPS never completes, even inside the radius', () => {
  const v = completion(pointMilesFromDest(5, { pingAgeMinutes: 40 }));
  assert.equal(v.shouldComplete, false);
  assert.match(v.reason, /old/);
});

test('evaluateDestinationCompletion: missing GPS → not complete', () => {
  assert.equal(completion(null).shouldComplete, false);
  assert.equal(completion({ latitude: null, longitude: null }).shouldComplete, false);
});

test('evaluateDestinationCompletion: missing/invalid destination → not complete, classified as missing coords', () => {
  for (const overrides of [
    { destination_lat: null }, // Number(null)===0 must NOT count as a coordinate
    { destination_lng: undefined },
    { destination_lat: NaN, destination_lng: NaN },
  ]) {
    const v = completion(pointMilesFromDest(2), overrides);
    assert.equal(v.shouldComplete, false);
    assert.equal(v.code, 'DESTINATION_COORDINATES_MISSING');
  }
});

test('evaluateDestinationCompletion: cancelled or already-completed routes never complete', () => {
  for (const status of ['cancelled', 'completed']) {
    const v = completion(pointMilesFromDest(1), { status });
    assert.equal(v.shouldComplete, false);
    assert.match(v.reason, new RegExp(status));
  }
});

test('evaluateDestinationCompletion: works WITHOUT an encoded polyline (destination coords are enough)', () => {
  const v = completion(pointMilesFromDest(3), { encoded_polyline: null });
  assert.equal(v.shouldComplete, true);
});
test('runRouteMonitorCheck auto-completes a route inside the radius, silently, skipping off-route', async () => {
  // Driver is 8 mi from the destination but off the encoded route. Completion
  // must fire FIRST: status completed, one audit event, ZERO telegram messages.
  const { svc, telegram, captured } = loadServiceForCompletion({
    assignments: [{
      id: 21, status: 'active', tracking_status: 'active',
      encoded_polyline: POLYLINE, // driver is nowhere near this
      destination_lat: 40, destination_lng: -100,
      consecutive_off_route: 2, group_name: 'G', telegram_group_id: -100500,
    }],
    location: NEAR_DEST_OFF_ROUTE,
  });
  const res = await svc.runRouteMonitorCheck(telegram, { now: NOW });
  assert.equal(res.completed, 1);
  assert.equal(res.notified, 0);
  assert.equal(captured.completed.length, 1);
  assert.equal(captured.completed[0].id, 21);
  assert.ok(Math.abs(captured.completed[0].data.distanceMeters - 8 * M_PER_MILE) < 2);
  // Exactly one completion audit event, no off-route/warning event.
  assert.equal(captured.events.length, 1);
  assert.equal(captured.events[0].eventType, 'destination_reached');
  assert.equal(captured.events[0].result, 'completed');
  assert.match(captured.events[0].detail, /Auto-completed: fresh GPS was 8\.0 miles/);
  // No Telegram message of any kind.
  assert.equal(captured.telegramSends.length, 0);
  // Off-route monitor state was NOT written (we skipped that branch).
  assert.equal(captured.monitorStates.length, 0);
});

test('runRouteMonitorCheck completes a route that has NO polyline (destination-only)', async () => {
  const { svc, telegram, captured } = loadServiceForCompletion({
    assignments: [{
      id: 22, status: 'active', tracking_status: 'active',
      encoded_polyline: null, destination_lat: 40, destination_lng: -100,
      group_name: 'G', telegram_group_id: -100501,
    }],
    location: pointMilesFromDest(4),
  });
  const res = await svc.runRouteMonitorCheck(telegram, { now: NOW });
  assert.equal(res.completed, 1);
  assert.equal(captured.events[0].eventType, 'destination_reached');
  assert.equal(captured.telegramSends.length, 0);
});

test('runRouteMonitorCheck does NOT double-complete on overlapping ticks', async () => {
  // completeRouteAssignment returns null → another tick already completed it.
  const { svc, telegram, captured } = loadServiceForCompletion({
    assignments: [{
      id: 23, status: 'active', tracking_status: 'active',
      encoded_polyline: null, destination_lat: 40, destination_lng: -100,
      group_name: 'G', telegram_group_id: -100502,
    }],
    location: pointMilesFromDest(2),
    completeReturns: 'raced',
  });
  const res = await svc.runRouteMonitorCheck(telegram, { now: NOW });
  assert.equal(captured.completed.length, 1, 'attempted once');
  assert.equal(res.completed, 0, 'not counted — lost the race');
  assert.equal(captured.events.length, 0, 'no duplicate audit event');
  assert.equal(captured.telegramSends.length, 0);
});

test('runRouteMonitorCheck keeps normal off-route warning when the driver is OUTSIDE the radius', async () => {
  // Far from destination AND off the route → completion does not fire; the
  // existing off-route warning path runs as before.
  const { svc, telegram, captured } = loadServiceForCompletion({
    assignments: [{
      id: 24, status: 'active', tracking_status: 'active',
      encoded_polyline: POLYLINE,
      destination_lat: 40, destination_lng: -100, // ~800+ mi from the polyline/off point
      consecutive_off_route: 2, last_notification_at: null,
      group_name: 'G', telegram_group_id: -100503,
    }],
    location: offRoute, // off the polyline, and nowhere near (40,-100)
  });
  const res = await svc.runRouteMonitorCheck(telegram, { now: NOW });
  assert.equal(res.completed, 0);
  assert.equal(res.checked, 1);
  assert.equal(res.notified, 1, 'off-route warning still sent');
  assert.equal(captured.telegramSends.length, 1);
  assert.match(captured.telegramSends[0].text, /off the assigned route/i);
  assert.ok(!captured.events.some((e) => e.eventType === 'destination_reached'));
});
