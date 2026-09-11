/**
 * The roster, and the two ways it silently goes wrong.
 *
 * A DUPLICATE KEY makes one of the two components invisible — whichever is
 * found second. It happened while this was being written: the notification
 * DRAIN (a worker: did the timer fire) and the notification QUEUE (an
 * integration: has anything given up undelivered) both wanted the name
 * `notifications`, and the integration's answer was silently dropped.
 *
 * AN UNCATALOGUED KEY is worse, because it looks like it works. A worker that
 * records under a key the catalog does not know gets a null expected interval,
 * which means staleness cannot be decided for it — so the one state only this
 * mechanism can see, `stale_stopped`, can never be reached for that worker. It
 * would report healthy forever, including after it stopped.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { CATALOG, getServiceEntry } = require('../lib/operations/backgroundServiceCatalog');

const ROOT = path.resolve(__dirname, '..');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('no two components share a key', () => {
  const seen = new Map();
  for (const entry of CATALOG) {
    assert.equal(seen.has(entry.key), false,
      `${entry.key} is listed twice — the second one would be invisible`);
    seen.set(entry.key, entry);
  }
});

test('every component has a label and a cadence staleness can be judged against', () => {
  for (const entry of CATALOG) {
    assert.ok(entry.label && entry.label.length > 3, `${entry.key} needs a human label`);
    assert.ok(Number.isFinite(entry.expectedIntervalSeconds) && entry.expectedIntervalSeconds > 0,
      `${entry.key} needs an expected interval, or it can never be called stopped`);
    assert.ok(['integration', 'queue', 'engine', 'routine'].includes(entry.group), entry.key);
  }
});

test('every key a service actually records under is in the catalog', () => {
  const files = [...walk(path.join(ROOT, 'services')), ...walk(path.join(ROOT, 'server'))];
  const pattern = /(?:withRunRecord|noteHeartbeat)\(\s*'([a-z0-9_]+)'/g;
  const used = new Set();
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(pattern)) used.add(m[1]);
  }

  assert.ok(used.size >= 15, `expected the roster to be wired up, found ${used.size} keys`);
  for (const key of used) {
    assert.ok(getServiceEntry(key),
      `"${key}" is recorded by a service but is not in the catalog — it would get a `
      + 'null expected interval and could never be reported as stopped');
  }
});

test('the workers on the critical list are the ones a person would be woken for', () => {
  const critical = CATALOG.filter((e) => e.critical).map((e) => e.key);
  for (const key of ['consistency_sweep', 'load_lifecycle', 'fuel_risk', 'return_to_road',
    'safety_coach', 'retention_watch', 'samsara_safety_pipeline', 'notifications',
    'telegram_delivery', 'scheduler']) {
    assert.ok(critical.includes(key), `${key} should be critical`);
  }
  // And the ones that should NOT wake anybody.
  for (const key of ['group_status_ai', 'road_bonus_notifier', 'mileage_bonus', 'learning_pass']) {
    assert.equal(getServiceEntry(key).critical, false,
      `${key} missing a tick is not an operational incident`);
  }
});

test('EVERY CATALOGUED ENTRY IS OBSERVABLE — by its ledger, or by a hand-written check', () => {
  // The gap this closes, found in review: `datatruck_documents` wrote ledger
  // records AND was skipped by `workerObservations` for being an integration,
  // while `integrationObservations` had no branch for it. A critical component
  // appeared in neither the Systems tab nor the public summary — a silent gap
  // of exactly the kind this whole mechanism exists to close.
  //
  // And `mileage_bonus` / `raise_approval` were catalogued without recording
  // anything, so they would have read `cannot_determine` forever: the screen
  // could never tell either job running from its timer stopping.
  const src = fs.readFileSync(
    require.resolve('../services/operations/healthObservations'), 'utf8'
  );
  const custom = new Set(
    [...src.matchAll(/'([a-z_]+)',?\s*$/gm)].map((m) => m[1])
  );
  const customBlock = src.slice(
    src.indexOf('const CUSTOM_INTEGRATIONS'), src.indexOf('/** When this process started')
  );
  const handled = new Set([...customBlock.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));

  // index.js too: the leads bot is a CHILD PROCESS, not a timer, so its
  // supervisor there is the only thing that can report on it.
  const files = [
    ...walk(path.join(ROOT, 'services')), ...walk(path.join(ROOT, 'server')),
    path.join(ROOT, 'index.js'),
  ];
  const recorded = new Set();
  for (const file of files) {
    const body = fs.readFileSync(file, 'utf8');
    for (const m of body.matchAll(/(?:withRunRecord|noteHeartbeat)\(\s*'([a-z0-9_]+)'/g)) {
      recorded.add(m[1]);
    }
  }

  const invisible = CATALOG.filter((e) => !handled.has(e.key) && !recorded.has(e.key));
  assert.deepEqual(invisible.map((e) => e.key), [],
    'these are in the roster and nothing observes them — they would read '
    + '"never reported" forever, which is worse than not listing them at all');
  assert.ok(custom.size >= 0);
});

test('a hand-written integration check exists for every key that claims one', () => {
  const src = fs.readFileSync(
    require.resolve('../services/operations/healthObservations'), 'utf8'
  );
  const customBlock = src.slice(
    src.indexOf('const CUSTOM_INTEGRATIONS'), src.indexOf('/** When this process started')
  );
  for (const m of customBlock.matchAll(/'([a-z_]+)'/g)) {
    const key = m[1];
    assert.ok(getServiceEntry(key), `${key} claims a custom check but is not in the catalogue`);
    assert.ok(src.includes(`integration('${key}'`),
      `${key} is skipped by the ledger path but has no hand-written observation — `
      + 'it would appear nowhere at all');
  }
});
