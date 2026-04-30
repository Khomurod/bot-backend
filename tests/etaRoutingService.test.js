const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  calculateEtaToDestination,
  extractDestinationCandidates,
  sanitizeDestinationQuery,
} = require('../services/etaRoutingService');
const { formatDuration, computeNextRunAt } = require('../services/dispatchEtaUpdateService');

test('sanitizeDestinationQuery appends USA once and removes existing US suffix', () => {
  assert.equal(sanitizeDestinationQuery('Anderson, TN 46013'), 'Anderson, TN 46013, USA');
  assert.equal(sanitizeDestinationQuery('Anderson, TN 46013, US'), 'Anderson, TN 46013, USA');
  assert.equal(sanitizeDestinationQuery('Anderson, TN 46013, USA'), 'Anderson, TN 46013, USA');
});

test('sanitizeDestinationQuery strips ETA-noise fields from destination text', () => {
  assert.equal(
    sanitizeDestinationQuery('1671 Greenbourne Dr #101, GREENSBORO, NC 27409 | 04/30 11:51 appt'),
    '1671 Greenbourne Dr #101, GREENSBORO, NC 27409, USA'
  );
});

test('extractDestinationCandidates keeps meaningful options from messy caption', () => {
  const candidates = extractDestinationCandidates(
    'Load 418911\nLive-Drop\nMN>NJ\nDelivery: 40305 John Mosby Hwy, Chantilly, VA 20152 | 05/01 1400'
  );
  assert.ok(candidates.length >= 2);
  assert.equal(candidates[0], '40305 John Mosby Hwy, Chantilly, VA 20152, USA');
  assert.ok(candidates.some((v) => v.includes('VA 20152')));
});

test('formatDuration renders minutes and hour/minute labels', () => {
  assert.equal(formatDuration(0), '0m');
  assert.equal(formatDuration(35), '35m');
  assert.equal(formatDuration(130), '2h 10m');
});

test('computeNextRunAt returns a future ISO timestamp', () => {
  const nowMs = Date.now();
  const nextIso = computeNextRunAt(15);
  const nextMs = Date.parse(nextIso);
  assert.ok(Number.isFinite(nextMs), 'next run should be a valid ISO timestamp');
  assert.ok(nextMs > nowMs, 'next run should be in the future');
});

test('calculateEtaToDestination returns approximate ETA when routing fails', async () => {
  const originalFetch = global.fetch;
  try {
    let callIndex = 0;
    global.fetch = async (_url) => {
      callIndex += 1;
      if (callIndex === 1) {
        return {
          ok: true,
          async json() {
            return [{
              lat: '35.042300',
              lon: '-89.930000',
              display_name: 'Memphis, Tennessee, United States',
              importance: 0.9,
              address: { city: 'Memphis', state: 'Tennessee', postcode: '38118' },
            }];
          },
        };
      }
      return {
        ok: false,
        async json() {
          return {};
        },
      };
    };

    const eta = await calculateEtaToDestination({
      currentLatitude: 35.0,
      currentLongitude: -90.0,
      destinationQuery: '5151 E RAINES RD, Memphis, TN 38118',
    });
    assert.ok(eta);
    assert.equal(eta.approximate, true);
    assert.ok(eta.etaMinutes > 0);
    assert.ok(eta.remainingMiles > 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test('calculateEtaToDestination uses Google route fallback when OSRM fails', async () => {
  const servicePath = path.resolve(__dirname, '../services/etaRoutingService.js');
  const configPath = path.resolve(__dirname, '../config/config.js');
  const originalConfigCache = require.cache[configPath];
  const originalServiceCache = require.cache[servicePath];
  const originalFetch = global.fetch;

  try {
    delete require.cache[servicePath];
    require.cache[configPath] = {
      exports: {
        googleMapsApiKey: 'test-key',
        googleGeocodingApiBase: 'https://maps.googleapis.com/maps/api/geocode/json',
        googleRoutesApiBase: 'https://routes.googleapis.com/directions/v2:computeRoutes',
      },
    };
    const svc = require(servicePath);

    let calls = 0;
    global.fetch = async (url) => {
      calls += 1;
      const u = String(url);
      if (u.includes('nominatim.openstreetmap.org')) {
        return {
          ok: true,
          async json() {
            return [{
              lat: '35.042300',
              lon: '-89.930000',
              display_name: 'Memphis, Tennessee, United States',
              importance: 0.9,
              address: { city: 'Memphis', state: 'Tennessee', postcode: '38118' },
            }];
          },
        };
      }
      if (u.includes('router.project-osrm.org')) {
        return {
          ok: false,
          async json() {
            return {};
          },
        };
      }
      if (u.includes('routes.googleapis.com')) {
        return {
          ok: true,
          async json() {
            return {
              routes: [
                {
                  distanceMeters: 210000,
                  duration: '7200s',
                },
              ],
            };
          },
        };
      }
      throw new Error(`Unexpected URL in test: ${u}`);
    };

    const eta = await svc.calculateEtaToDestination({
      currentLatitude: 35.0,
      currentLongitude: -90.0,
      destinationQuery: '5151 E RAINES RD, Memphis, TN 38118',
    });
    assert.ok(eta);
    assert.equal(eta.approximate, false);
    assert.ok(eta.etaMinutes >= 120);
    assert.ok(calls >= 3);
  } finally {
    global.fetch = originalFetch;
    delete require.cache[servicePath];
    if (originalServiceCache) require.cache[servicePath] = originalServiceCache;
    if (originalConfigCache) require.cache[configPath] = originalConfigCache;
    else delete require.cache[configPath];
  }
});

test('calculateEtaToDestination uses free alt OSRM fallback before Google', async () => {
  const servicePath = path.resolve(__dirname, '../services/etaRoutingService.js');
  const configPath = path.resolve(__dirname, '../config/config.js');
  const originalConfigCache = require.cache[configPath];
  const originalServiceCache = require.cache[servicePath];
  const originalFetch = global.fetch;

  try {
    delete require.cache[servicePath];
    require.cache[configPath] = {
      exports: {
        googleMapsApiKey: '',
        googleGeocodingApiBase: 'https://maps.googleapis.com/maps/api/geocode/json',
        googleRoutesApiBase: 'https://routes.googleapis.com/directions/v2:computeRoutes',
      },
    };
    const svc = require(servicePath);

    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes('nominatim.openstreetmap.org')) {
        return {
          ok: true,
          async json() {
            return [{
              lat: '35.042300',
              lon: '-89.930000',
              display_name: 'Memphis, Tennessee, United States',
              importance: 0.9,
              address: { city: 'Memphis', state: 'Tennessee', postcode: '38118' },
            }];
          },
        };
      }
      if (u.includes('router.project-osrm.org')) {
        return {
          ok: false,
          async json() {
            return {};
          },
        };
      }
      if (u.includes('routing.openstreetmap.de')) {
        return {
          ok: true,
          async json() {
            return {
              routes: [
                {
                  distance: 160934, // 100 miles
                  duration: 9000, // 150 minutes
                },
              ],
            };
          },
        };
      }
      throw new Error(`Unexpected URL in test: ${u}`);
    };

    const eta = await svc.calculateEtaToDestination({
      currentLatitude: 35.0,
      currentLongitude: -90.0,
      destinationQuery: '5151 E RAINES RD, Memphis, TN 38118',
    });
    assert.ok(eta);
    assert.equal(eta.approximate, false);
    assert.equal(eta.remainingMiles, 100);
  } finally {
    global.fetch = originalFetch;
    delete require.cache[servicePath];
    if (originalServiceCache) require.cache[servicePath] = originalServiceCache;
    if (originalConfigCache) require.cache[configPath] = originalConfigCache;
    else delete require.cache[configPath];
  }
});

