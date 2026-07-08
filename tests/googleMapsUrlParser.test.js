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

test('path form ignores the am=t / entry / dir_action map-state segments (regression)', () => {
  // Real expanded shape of maps.app.goo.gl/ELB6VP2bJcQSZXj37: a 2-stop route
  // whose path carries an @center, an `am=t` flag, and a `data=` blob. The
  // `am=t` segment must NOT be read as the destination.
  const url = 'https://www.google.com/maps/dir/'
    + '5910+Dylan+Dr,+South+Bend,+IN+46628,+%D0%A1%D0%A8%D0%90/'
    + '43035+John+Mosby+Hwy,+Chantilly,+VA+20152,+%D0%A1%D0%A8%D0%90/'
    + '@40.2215688,-87.179762,6z/am=t/data=!3m1!4b1!4m14?entry=tts';
  const p = parseDirectionsUrl(url);
  assert.equal(p.parseable, true);
  assert.equal(p.origin.raw, '5910 Dylan Dr, South Bend, IN 46628, США');
  assert.equal(p.destination.raw, '43035 John Mosby Hwy, Chantilly, VA 20152, США');
  assert.equal(p.waypoints.length, 0);
});

test('flags a shortened Google Maps link (not parseable, must be expanded)', () => {
  const p = parseDirectionsUrl('https://maps.app.goo.gl/AbCdEf123');
  assert.equal(p.parseable, false);
  assert.equal(p.isShortLink, true);
  assert.match(p.reason, /short/i);
  assert.equal(isShortLinkHost('maps.app.goo.gl'), true);
});

test('parses a desktop /maps/dir/ directions link', () => {
  const p = parseDirectionsUrl('https://www.google.com/maps/dir/Chicago,+IL/Dallas,+TX/');
  assert.equal(p.parseable, true);
  assert.equal(p.origin.raw, 'Chicago, IL');
  assert.equal(p.destination.raw, 'Dallas, TX');
});

test('parses a mobile maps.google.com directions link', () => {
  const p = parseDirectionsUrl(
    'https://maps.google.com/maps/dir/?api=1&origin=Chicago,IL&destination=Dallas,TX'
  );
  assert.equal(p.parseable, true);
  assert.equal(p.origin.raw, 'Chicago,IL');
  assert.equal(p.destination.raw, 'Dallas,TX');
});

test('returns the specific place/map-view error for a bare /maps/@ map view', () => {
  const p = parseDirectionsUrl('https://www.google.com/maps/@33.7,-84.3,12z');
  assert.equal(p.parseable, false);
  assert.equal(p.isShortLink, false);
  assert.equal(p.placeOrMapView, true);
  assert.match(p.reason, /place\/map view/i);
});

test('returns the specific place/map-view error for a /maps/place link', () => {
  const p = parseDirectionsUrl('https://www.google.com/maps/place/Somewhere/@33.7,-84.3,12z');
  assert.equal(p.parseable, false);
  assert.equal(p.placeOrMapView, true);
  assert.match(p.reason, /place\/map view|manually/i);
});

test('a short link expanding to a /maps/@ map view is rejected clearly (mock fetchImpl)', async () => {
  // Mirrors the real maps.app.goo.gl/nfC9… case: 302 → a bare map view with no
  // origin/destination. Expansion succeeds but parsing must reject specifically.
  const mapView = 'https://www.google.com/maps/@44.94,-93.07,4666a,13.1y/data=abc';
  const fetchImpl = async () => ({
    status: 302,
    url: 'https://maps.app.goo.gl/nfC9vyrCuCddTqJT6',
    headers: { get: (h) => (h === 'location' ? mapView : null) },
  });
  const expanded = await expandShortLink('https://maps.app.goo.gl/nfC9vyrCuCddTqJT6', { fetchImpl });
  assert.equal(expanded, mapView);
  const p = parseDirectionsUrl(expanded);
  assert.equal(p.parseable, false);
  assert.equal(p.placeOrMapView, true);
  assert.match(p.reason, /place\/map view/i);
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
