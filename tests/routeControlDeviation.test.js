/**
 * Route Control deviation decisions (evaluateAssignment) and Google Maps
 * link parsing (parseRouteLink) — pure logic, no env / network / database.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadService, loadServiceWith, SETTINGS, NOW, assignment, onRoute, offRoute,
} = require('./helpers/routeControlHarness');

const service = loadService();
const { evaluateAssignment } = service;

test('on-route ping → on_route, streak reset, no warning', () => {
  const v = evaluateAssignment({
    assignment: assignment({ consecutive_off_route: 2 }), location: onRoute, settings: SETTINGS, now: NOW,
  });
  assert.equal(v.result, 'on_route');
  assert.ok(v.deviationMeters < 250);
  assert.equal(v.consecutiveOffRoute, 0);
  assert.equal(v.shouldNotify, false);
});

test('off-route distance is measured and exceeds the threshold', () => {
  const v = evaluateAssignment({
    assignment: assignment(), location: offRoute, settings: SETTINGS, now: NOW,
  });
  assert.equal(v.result, 'off_route');
  assert.ok(v.deviationMeters > SETTINGS.deviationThresholdMeters);
});

test('one bad ping does not warn — grace threshold must be reached first', () => {
  const first = evaluateAssignment({
    assignment: assignment({ consecutive_off_route: 0 }), location: offRoute, settings: SETTINGS, now: NOW,
  });
  assert.equal(first.consecutiveOffRoute, 1);
  assert.equal(first.shouldNotify, false);

  const second = evaluateAssignment({
    assignment: assignment({ consecutive_off_route: 1 }), location: offRoute, settings: SETTINGS, now: NOW,
  });
  assert.equal(second.consecutiveOffRoute, 2);
  assert.equal(second.shouldNotify, false);

  const third = evaluateAssignment({
    assignment: assignment({ consecutive_off_route: 2 }), location: offRoute, settings: SETTINGS, now: NOW,
  });
  assert.equal(third.consecutiveOffRoute, 3); // reached grace
  assert.equal(third.shouldNotify, true);
});

test('notification cooldown prevents spamming warnings', () => {
  const recent = new Date(NOW.getTime() - 10 * 60 * 1000).toISOString(); // 10 min ago
  const withinCooldown = evaluateAssignment({
    assignment: assignment({ consecutive_off_route: 2, last_notification_at: recent }),
    location: offRoute, settings: SETTINGS, now: NOW,
  });
  assert.equal(withinCooldown.result, 'off_route');
  assert.equal(withinCooldown.shouldNotify, false);

  const old = new Date(NOW.getTime() - 40 * 60 * 1000).toISOString(); // 40 min ago > cooldown
  const afterCooldown = evaluateAssignment({
    assignment: assignment({ consecutive_off_route: 2, last_notification_at: old }),
    location: offRoute, settings: SETTINGS, now: NOW,
  });
  assert.equal(afterCooldown.shouldNotify, true);
});

test('stale GPS never warns (logged as stale)', () => {
  const v = evaluateAssignment({
    assignment: assignment({ consecutive_off_route: 2 }),
    location: { ...offRoute, pingAgeMinutes: 40 }, settings: SETTINGS, now: NOW,
  });
  assert.equal(v.result, 'stale');
  assert.equal(v.shouldNotify, false);
  assert.equal(v.consecutiveOffRoute, 2); // streak unchanged
});

test('missing GPS is not_checked, never a warning', () => {
  const v = evaluateAssignment({
    assignment: assignment({ consecutive_off_route: 2 }), location: null, settings: SETTINGS, now: NOW,
  });
  assert.equal(v.result, 'not_checked');
  assert.equal(v.shouldNotify, false);
});

test('off-route but parked/slow does not escalate', () => {
  const v = evaluateAssignment({
    assignment: assignment({ consecutive_off_route: 2 }),
    location: { ...offRoute, speedMilesPerHour: 2 }, settings: SETTINGS, now: NOW,
  });
  assert.equal(v.result, 'parked');
  assert.equal(v.shouldNotify, false);
  assert.equal(v.consecutiveOffRoute, 2);
});

test('completed and cancelled routes are not monitored', () => {
  for (const status of ['completed', 'cancelled']) {
    const v = evaluateAssignment({
      assignment: assignment({ status, consecutive_off_route: 2 }),
      location: offRoute, settings: SETTINGS, now: NOW,
    });
    assert.equal(v.result, 'not_monitored');
    assert.equal(v.shouldNotify, false);
  }
});

test('an assignment with no geometry is not monitored', () => {
  const v = evaluateAssignment({
    assignment: assignment({ encoded_polyline: null }), location: offRoute, settings: SETTINGS, now: NOW,
  });
  assert.equal(v.result, 'no_geometry');
  assert.equal(v.shouldNotify, false);
});

// ── parseRouteLink ──

test('parseRouteLink resolves a standard directions link', async () => {
  const parsed = await service.parseRouteLink(
    'https://www.google.com/maps/dir/?api=1&origin=Atlanta,GA&destination=Miami,FL'
  );
  assert.equal(parsed.origin.raw, 'Atlanta,GA');
  assert.equal(parsed.destination.raw, 'Miami,FL');
});

test('parseRouteLink throws a clear error for an unreadable link', async () => {
  await assert.rejects(
    () => service.parseRouteLink('https://www.google.com/maps/@33.7,-84.3,12z'),
    /manually|origin and destination|place\/map view/i
  );
});

test('parseRouteLink throws the specific place/map-view error for a /maps/@ link', async () => {
  await assert.rejects(
    () => service.parseRouteLink('https://www.google.com/maps/@44.94,-93.07,13z'),
    (err) => {
      assert.equal(err.code, 'PLACE_OR_MAP_VIEW');
      assert.match(err.message, /place\/map view/i);
      return true;
    }
  );
});
