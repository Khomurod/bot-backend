/**
 * Part 2 guard: the Admin Trailer Tracking page must NOT have its own
 * Map / Locations tab (trailers now render inside the shared Live Locations
 * map). The other tabs must remain.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * The whole Trailer Tracking page: the tab shell plus every component behind it
 * in ./trailerTracking. Reading the set rather than one file keeps this guard
 * about the FEATURE — which tabs exist, and that no map tab does — instead of
 * which file a tab definition happens to live in.
 */
const PAGES = path.resolve(__dirname, '../admin/src/pages');
const COMPONENTS = path.join(PAGES, 'trailerTracking');
const src = [fs.readFileSync(path.join(PAGES, 'TrailerTrackingPage.jsx'), 'utf8')]
  .concat(fs.readdirSync(COMPONENTS)
    .filter((f) => f.endsWith('.jsx') || f.endsWith('.js'))
    .map((f) => fs.readFileSync(path.join(COMPONENTS, f), 'utf8')))
  .join('\n');

test('admin Trailer Tracking has no Map / Locations tab', () => {
  assert.ok(!/key:\s*["']map["']/.test(src), 'a map tab key is still defined');
  assert.ok(!/Map\s*\/\s*Locations/.test(src), 'the "Map / Locations" label is still present');
});

test('admin Trailer Tracking keeps its other tabs', () => {
  for (const label of ['Trailer List', 'Upload / Import', 'Events History', 'Unidentified', 'Settings']) {
    assert.ok(src.includes(label), `tab "${label}" is missing`);
  }
});

test('admin Trailer Tracking no longer imports Leaflet (map removed)', () => {
  assert.ok(!/from ["']leaflet["']/.test(src), 'leaflet import should be gone from the trailer page');
});
