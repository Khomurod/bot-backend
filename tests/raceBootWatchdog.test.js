'use strict';

/**
 * The race screens recover by themselves when their code never starts.
 *
 * /dispatch and /dispatchteam run in a kiosk window nobody refreshes. A reload
 * that met a deploy half-way got a page whose script the server no longer had;
 * the browser refused what came back, nothing ran, and the screen stayed blank
 * until somebody walked over (the owner, 2 November 2026). The inline script
 * in admin/index.html is the one thing that still runs then. This runs THAT
 * script — read from the file, not a copy — with a fake clock.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'admin/index.html'), 'utf8');
const watchdog = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1])
  .find((body) => body.includes('race-boot-watchdog'));

function run(pathname, { retries = null, started = false } = {}) {
  const timers = [];
  const store = new Map(retries === null ? [] : [['grossRace.bootRetries', String(retries)]]);
  let reloads = 0;
  const window = {};
  const context = {
    window,
    location: { pathname, reload: () => { reloads += 1; } },
    sessionStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
  };
  vm.runInNewContext(watchdog, context);
  if (started) window.__grossRaceStarted = true;
  for (const t of timers) t.fn();
  return { timers: timers.map((t) => t.ms), reloads: () => reloads, stored: store.get('grossRace.bootRetries') };
}

test('the watchdog is in the page, ahead of the app script', () => {
  assert.ok(watchdog, 'admin/index.html has the race-boot-watchdog script');
  assert.ok(html.indexOf('race-boot-watchdog') < html.indexOf('type="module"'));
});

test('a race board that never started reloads after a minute, and counts it', () => {
  for (const pathname of ['/dispatchteam', '/dispatchteam/', '/dispatch']) {
    const out = run(pathname);
    assert.deepEqual(out.timers, [60000], pathname);
    assert.equal(out.reloads(), 1, pathname);
    assert.equal(out.stored, '1', pathname);
  }
});

test('a board that started is left alone', () => {
  const out = run('/dispatchteam', { started: true });
  assert.deepEqual(out.timers, [60000]);
  assert.equal(out.reloads(), 0);
});

test('each failed start waits twice as long, never more than ten minutes', () => {
  assert.deepEqual(run('/dispatchteam', { retries: 1 }).timers, [120000]);
  assert.deepEqual(run('/dispatchteam', { retries: 3 }).timers, [480000]);
  assert.deepEqual(run('/dispatchteam', { retries: 9 }).timers, [600000]);
});

test('every other page of the panel is untouched', () => {
  for (const pathname of ['/admin', '/admin/', '/recruiters', '/', '/dispatchteams']) {
    assert.deepEqual(run(pathname).timers, [], pathname);
  }
});

test('the board stands the watchdog down with the same names the page uses', () => {
  const page = fs.readFileSync(path.join(ROOT, 'admin/src/pages/grossRace/pageVersion.js'), 'utf8');
  assert.match(page, /BOOT_FLAG = "__grossRaceStarted"/);
  assert.match(page, /BOOT_RETRIES = "grossRace\.bootRetries"/);
  assert.match(watchdog, /window\.__grossRaceStarted/);
  assert.match(watchdog, /"grossRace\.bootRetries"/);
  const board = fs.readFileSync(path.join(ROOT, 'admin/src/pages/grossRace/GrossRacePage.jsx'), 'utf8');
  assert.match(board, /useEffect\(\(\) => \{ markBooted\(\); \}, \[\]\)/);
});
