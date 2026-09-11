/**
 * The fleet snapshot is fetched once a minute, not once per caller.
 *
 * THE COST THIS REMOVES. Route Control resolves each active assignment's GPS
 * separately and each resolution fetched the entire paginated fleet — so ten
 * active assignments meant ten complete fetches every check interval, around
 * fourteen thousand a day, for a hundred trucks whose positions were identical
 * in all ten. The duplicate-unit scan, the fuel watch and the load watch each
 * ask for the same snapshot on their own timers as well.
 *
 * Two properties matter more than the saving, and both are refusals: two API
 * keys must never share an entry, and a FAILED fetch must never be cached — a
 * caller reading positions from before an outage and believing them current is
 * worse than one more request.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const service = require('../services/samsaraLocationService');

function stubFetch(pages) {
  let calls = 0;
  const real = global.fetch;
  global.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      async json() { return pages; },
      async text() { return JSON.stringify(pages); },
    };
  };
  return { restore: () => { global.fetch = real; }, count: () => calls };
}

const FLEET = { data: [{ id: 'v1', name: 'WENZE UNIT # 310', gps: { time: '2026-09-20T17:55:00Z' } }], pagination: {} };

test('ten callers in the same minute cost ONE fetch', async (t) => {
  service.clearFleetCache();
  const f = stubFetch(FLEET);
  t.after(() => { f.restore(); service.clearFleetCache(); });

  const first = await service.fetchAllVehicleStats({ apiKey: 'k1', apiBase: 'https://x' });
  assert.equal(f.count(), 1);
  for (let i = 0; i < 9; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await service.fetchAllVehicleStats({ apiKey: 'k1', apiBase: 'https://x' });
  }
  assert.equal(f.count(), 1, 'ten assignments used to mean ten complete fleet fetches');
  assert.equal(first.length, 1);
});

test('callers arriving together share one in-flight request', async (t) => {
  service.clearFleetCache();
  const f = stubFetch(FLEET);
  t.after(() => { f.restore(); service.clearFleetCache(); });

  const all = await Promise.all(
    Array.from({ length: 8 }, () => service.fetchAllVehicleStats({ apiKey: 'k1', apiBase: 'https://x' }))
  );
  assert.equal(f.count(), 1, 'eight at once is one request, not eight then a cache');
  assert.equal(all.every((v) => v.length === 1), true);
});

test('TWO KEYS ADDRESS DIFFERENT FLEETS and never share an entry', async (t) => {
  service.clearFleetCache();
  const f = stubFetch(FLEET);
  t.after(() => { f.restore(); service.clearFleetCache(); });

  await service.fetchAllVehicleStats({ apiKey: 'k1', apiBase: 'https://x' });
  await service.fetchAllVehicleStats({ apiKey: 'k2', apiBase: 'https://x' });
  assert.equal(f.count(), 2, 'returning one fleet for another key would put the wrong '
    + 'truck on a driver’s alert');

  await service.fetchAllVehicleStats({ apiKey: 'k1', apiBase: 'https://y' });
  assert.equal(f.count(), 3, 'and a different base is a different fleet too');
});

test('A FAILED FETCH IS NOT CACHED', async (t) => {
  service.clearFleetCache();
  const real = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    throw new Error('ECONNRESET');
  };
  t.after(() => { global.fetch = real; service.clearFleetCache(); });

  await assert.rejects(() => service.fetchAllVehicleStats({ apiKey: 'k1', apiBase: 'https://x' }));
  await assert.rejects(() => service.fetchAllVehicleStats({ apiKey: 'k1', apiBase: 'https://x' }));
  assert.equal(calls, 2,
    'a caller reading positions from before an outage and believing them current '
    + 'is worse than one more request');
});

test('an explicit refresh bypasses the cache', async (t) => {
  service.clearFleetCache();
  const f = stubFetch(FLEET);
  t.after(() => { f.restore(); service.clearFleetCache(); });

  await service.fetchAllVehicleStats({ apiKey: 'k1', apiBase: 'https://x' });
  await service.fetchAllVehicleStats({ apiKey: 'k1', apiBase: 'https://x', fresh: true });
  assert.equal(f.count(), 2);
});

test('the window is shorter than every caller’s interval', () => {
  // Route Control's floor, the fuel watch at 20 minutes, the load watch at 10,
  // the duplicate scan at 15 — all longer than this, so no caller ever reads a
  // snapshot older than its own cadence.
  assert.ok(service.FLEET_CACHE_MS <= 60 * 1000);
});
