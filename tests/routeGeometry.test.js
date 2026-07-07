const test = require('node:test');
const assert = require('node:assert/strict');
const {
  decodePolyline, haversineMeters, distancePointToPolylineMeters,
} = require('../services/routeGeometry');

// Google's canonical encoded-polyline example.
const CANONICAL = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';
const CANONICAL_POINTS = [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]];

test('decodePolyline matches the canonical Google example', () => {
  const points = decodePolyline(CANONICAL);
  assert.equal(points.length, 3);
  for (let i = 0; i < points.length; i += 1) {
    assert.ok(Math.abs(points[i][0] - CANONICAL_POINTS[i][0]) < 1e-5);
    assert.ok(Math.abs(points[i][1] - CANONICAL_POINTS[i][1]) < 1e-5);
  }
});

test('decodePolyline returns [] for empty/invalid input', () => {
  assert.deepEqual(decodePolyline(''), []);
  assert.deepEqual(decodePolyline(null), []);
});

test('haversineMeters is ~0 for the same point and sane for a known distance', () => {
  assert.ok(haversineMeters([38.5, -120.2], [38.5, -120.2]) < 0.001);
  // ~1 degree of latitude ≈ 111 km.
  const d = haversineMeters([38.0, -120.0], [39.0, -120.0]);
  assert.ok(d > 110_000 && d < 112_000);
});

test('distancePointToPolyline is ~0 on the route and large off the route', () => {
  const onRoute = distancePointToPolylineMeters([38.5, -120.2], CANONICAL_POINTS);
  assert.ok(onRoute < 1, `on-route deviation should be ~0, got ${onRoute}`);

  // A point ~1.2° of longitude east of the first vertex is far off route.
  const offRoute = distancePointToPolylineMeters([38.5, -119.0], CANONICAL_POINTS);
  assert.ok(offRoute > 50_000, `off-route deviation should be large, got ${offRoute}`);
});

test('distancePointToPolyline measures perpendicular distance to a segment, not just vertices', () => {
  // Segment along the equator from (0,0) to (0,1). A point at (0.01, 0.5) is
  // ~1.1 km north of the mid-segment — far less than the distance to either end.
  const seg = [[0, 0], [0, 1]];
  const d = distancePointToPolylineMeters([0.01, 0.5], seg);
  assert.ok(d > 900 && d < 1300, `expected ~1.1km perpendicular, got ${d}`);
});

test('distancePointToPolyline returns null for empty geometry', () => {
  assert.equal(distancePointToPolylineMeters([1, 2], []), null);
});
