/**
 * Route Control driver-facing message formatting — pure: cleanAddressText and
 * buildDriverGroupRouteMessage (escaping, country-suffix stripping, waypoint
 * numbering, the Telegram length budget, and the tracking section).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadService } = require('./helpers/routeControlHarness');

const service = loadService();

// ── buildDriverGroupRouteMessage (pure) ──

test('buildDriverGroupRouteMessage escapes place text and href, keeps the mention', () => {
  const msg = service.buildDriverGroupRouteMessage(
    {
      original_url: 'https://maps.google.com/dir?a=1&b=2',
      origin_text: 'A & B',
      destination_text: 'C <x>',
      waypoints: [{ raw: 'W & Z' }],
    },
    { mentionHtml: '<a href="tg://user?id=9">Bob</a>' }
  );
  assert.match(msg, /🚚 <b>Route Assigned<\/b>/);
  assert.match(msg, /tg:\/\/user\?id=9/);
  assert.match(msg, /<b>Origin<\/b>\nA &amp; B/);
  assert.match(msg, /<b>Destination<\/b>\nC &lt;x&gt;/);
  // Waypoints are numbered, one per line.
  assert.match(msg, /<b>Stops \/ Waypoints<\/b>\n1\. W &amp; Z/);
  assert.match(msg, /href="https:\/\/maps\.google\.com\/dir\?a=1&amp;b=2"/);
  // No raw unescaped ampersand from the place text leaks into the body.
  assert.ok(!/A & B/.test(msg));
});

test('buildDriverGroupRouteMessage omits the link line for a manual (non-http) entry', () => {
  const msg = service.buildDriverGroupRouteMessage(
    { original_url: '(manual entry)', origin_text: 'A', destination_text: 'B', waypoints: [] },
    { mentionHtml: 'Bob' }
  );
  assert.ok(!/Open route in Google Maps/.test(msg));
  assert.match(msg, /<b>Origin<\/b>\nA/);
});
// ── Clean English route message ──────────────────────────────────────────────

test('cleanAddressText strips Cyrillic and English country suffixes', () => {
  assert.equal(service.cleanAddressText('400 Oldfield Blvd, Pittston, PA 18640, США'), '400 Oldfield Blvd, Pittston, PA 18640');
  assert.equal(service.cleanAddressText('Monteagle, TN 37356, Соединенные Штаты Америки'), 'Monteagle, TN 37356');
  assert.equal(service.cleanAddressText('Hanahan, SC 29410, Соединённые Штаты'), 'Hanahan, SC 29410');
  assert.equal(service.cleanAddressText('Dillon, SC 29536, USA'), 'Dillon, SC 29536');
  assert.equal(service.cleanAddressText('Dallas, TX, United States of America'), 'Dallas, TX');
  assert.equal(service.cleanAddressText('  Chicago,   IL  '), 'Chicago, IL');
});

test('buildDriverGroupRouteMessage removes США from every section and numbers the stops', () => {
  const msg = service.buildDriverGroupRouteMessage({
    original_url: 'https://maps.app.goo.gl/x',
    origin_text: '32.956089, -80.005777',
    destination_text: '400 Oldfield Blvd, Pittston, PA 18640, США',
    waypoints: [
      { raw: 'Expeditors International — 1017 N Pointe Industrial Blvd, Hanahan, SC 29410, США' },
      { raw: 'Trade Zone Blvd, Summerville, SC 29486, Соединенные Штаты' },
      { raw: 'C.H. Robinson — 1911 SC-34, Dillon, SC 29536, USA' },
    ],
    tracking_start_mode: 'immediate', tracking_status: 'active',
  }, { mentionHtml: '@driver' });
  assert.ok(!/США|Соединенн|Соединённ/.test(msg), 'no Cyrillic country labels remain');
  assert.match(msg, /1\. Expeditors International — 1017 N Pointe Industrial Blvd, Hanahan, SC 29410/);
  assert.match(msg, /2\. Trade Zone Blvd, Summerville, SC 29486/);
  assert.match(msg, /3\. C\.H\. Robinson — 1911 SC-34, Dillon, SC 29536/);
  assert.match(msg, /<b>Tracking<\/b>/);
  assert.match(msg, /Route Control is now monitoring/);
});

test('buildDriverGroupRouteMessage stays under the Telegram text limit with huge waypoint lists', () => {
  const waypoints = Array.from({ length: 120 }, (_, i) => ({
    raw: `Stop ${i + 1} — Warehouse With A Really Long Name, 12345 Industrial Parkway Boulevard, Suite ${i + 1}, Some City, ST 00000`,
  }));
  const msg = service.buildDriverGroupRouteMessage({
    original_url: 'https://maps.google.com/dir?x=1',
    origin_text: 'A', destination_text: 'B', waypoints,
  }, { mentionHtml: '@driver' });
  assert.ok(msg.length <= 4096, `message must fit Telegram text limit (got ${msg.length})`);
  assert.match(msg, /… and \d+ more stops/);
});

test('buildDriverGroupRouteMessage describes scheduled and start-location tracking', () => {
  const scheduled = service.buildDriverGroupRouteMessage({
    original_url: '(manual entry)', origin_text: 'A', destination_text: 'B', waypoints: [],
    tracking_start_mode: 'scheduled_time', tracking_start_at: '2026-08-01T15:00:00Z', tracking_status: 'pending',
  }, { mentionHtml: '@d' });
  assert.match(scheduled, /will start monitoring at .*CST/);

  const byLocation = service.buildDriverGroupRouteMessage({
    original_url: '(manual entry)', origin_text: 'A', destination_text: 'B', waypoints: [],
    tracking_start_mode: 'start_location', tracking_start_location_text: '35.2331, -85.7095',
    tracking_start_radius_miles: 3, tracking_status: 'pending',
  }, { mentionHtml: '@d' });
  assert.match(byLocation, /when the truck reaches 35\.2331, -85\.7095 \(within 3 mi\)/);
});
