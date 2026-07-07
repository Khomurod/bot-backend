const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseDirectionsUrl, classifyPoint, expandShortLink, isShortLinkHost,
} = require('../services/googleMapsUrlParser');

test('classifyPoint recognizes lat,lng and leaves place strings alone', () => {
  const coord = classifyPoint('33.749,-84.388');
  assert.equal(coord.lat, 33.749);
  assert.equal(coord.lng, -84.388);
  const place = classifyPoint('Atlanta,+GA');
  assert.equal(place.lat, null);
  assert.equal(place.raw, 'Atlanta, GA');
});

test('parses the Maps URLs API form (?api=1&origin&destination&waypoints)', () => {
  const url = 'https://www.google.com/maps/dir/?api=1&origin=Atlanta,GA'
    + '&destination=Miami,FL&waypoints=Orlando,FL|Tampa,FL';
  const p = parseDirectionsUrl(url);
  assert.equal(p.parseable, true);
  assert.equal(p.origin.raw, 'Atlanta,GA');
  assert.equal(p.destination.raw, 'Miami,FL');
  assert.equal(p.waypoints.length, 2);
  assert.equal(p.waypoints[0].raw, 'Orlando,FL');
});

test('parses coordinates in the api=1 form', () => {
  const url = 'https://www.google.com/maps/dir/?api=1&origin=33.749,-84.388&destination=25.7617,-80.1918';
  const p = parseDirectionsUrl(url);
  assert.equal(p.parseable, true);
  assert.equal(p.origin.lat, 33.749);
  assert.equal(p.destination.lng, -80.1918);
  assert.equal(p.waypoints.length, 0);
});

test('parses the /maps/dir/ path form and ignores @/data segments', () => {
  const url = 'https://www.google.com/maps/dir/Atlanta,+GA/Orlando,+FL/Miami,+FL/'
    + '@28.5,-81.3,7z/data=!4m2!4m1!3e0';
  const p = parseDirectionsUrl(url);
  assert.equal(p.parseable, true);
  assert.equal(p.origin.raw, 'Atlanta, GA');
  assert.equal(p.destination.raw, 'Miami, FL');
  assert.equal(p.waypoints.length, 1);
  assert.equal(p.waypoints[0].raw, 'Orlando, FL');
});

test('flags a shortened Google Maps link (not parseable, must be expanded)', () => {
  const p = parseDirectionsUrl('https://maps.app.goo.gl/AbCdEf123');
  assert.equal(p.parseable, false);
  assert.equal(p.isShortLink, true);
  assert.match(p.reason, /short/i);
  assert.equal(isShortLinkHost('maps.app.goo.gl'), true);
});

test('returns a clear error for an opaque link with no directions', () => {
  const p = parseDirectionsUrl('https://www.google.com/maps/@33.7,-84.3,12z');
  assert.equal(p.parseable, false);
  assert.equal(p.isShortLink, false);
  assert.match(p.reason, /origin and destination|directions/i);
});

test('rejects a non-Google URL with a clear error', () => {
  const p = parseDirectionsUrl('https://example.com/maps/dir/A/B');
  assert.equal(p.parseable, false);
  assert.match(p.reason, /Google Maps/i);
});

test('rejects a single-point directions link with a clear error', () => {
  const p = parseDirectionsUrl('https://www.google.com/maps/dir/Miami,+FL/@25,-80,7z');
  assert.equal(p.parseable, false);
  assert.match(p.reason, /start point|origin/i);
});

test('expandShortLink follows a redirect to the full directions URL', async () => {
  const full = 'https://www.google.com/maps/dir/?api=1&origin=A&destination=B';
  const fetchImpl = async () => ({
    status: 301,
    url: 'https://maps.app.goo.gl/AbCdEf123',
    headers: { get: (h) => (h === 'location' ? full : null) },
  });
  const expanded = await expandShortLink('https://maps.app.goo.gl/AbCdEf123', { fetchImpl });
  assert.equal(expanded, full);
});

test('expandShortLink refuses to follow a redirect off Google', async () => {
  const fetchImpl = async () => ({
    status: 302, url: '', headers: { get: () => 'https://evil.example.com/x' },
  });
  await assert.rejects(
    () => expandShortLink('https://maps.app.goo.gl/AbCdEf123', { fetchImpl }),
    /off Google Maps/i
  );
});
