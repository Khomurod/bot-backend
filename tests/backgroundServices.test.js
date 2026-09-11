'use strict';

/**
 * The background-service roster.
 *
 * Split out of index.js, and the split is exactly the kind that loses something
 * quietly: a service whose `start` moved and whose `stop` did not still runs
 * and never shuts down, and nothing fails — not a test, not a lint, not a boot.
 * It shows up weeks later as a timer firing in a process that was supposed to
 * have gone away.
 *
 * So the file is read as text and its two halves are compared against each
 * other. It is a crude test and it is the right one: the property is about the
 * LIST, not about any behaviour a fake could exercise.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const SOURCE = fs.readFileSync(require.resolve('../services/backgroundServices'), 'utf8');
const INDEX = fs.readFileSync(require.resolve('../index.js'), 'utf8');

const [startHalf, stopHalf] = (() => {
  const marker = 'function stopBackgroundServices()';
  const at = SOURCE.indexOf(marker);
  assert.ok(at > 0, 'the file has both halves');
  return [SOURCE.slice(0, at), SOURCE.slice(at)];
})();

/** Every `startXService()` / `stopXService()` call, as its bare name. */
const called = (text, prefix) => new Set(
  [...text.matchAll(new RegExp(`\\b${prefix}([A-Z][A-Za-z]*)\\(`, 'g'))].map((m) => m[1])
);

test('every service that is started is also stopped', () => {
  const started = called(startHalf, 'start');
  const stopped = called(stopHalf, 'stop');
  const missing = [...started].filter((name) => !stopped.has(name));
  assert.deepEqual(missing, [], `started but never stopped: ${missing.join(', ')}`);
});

test('nothing is stopped that is never started', () => {
  const started = called(startHalf, 'start');
  const stopped = called(stopHalf, 'stop');
  const orphans = [...stopped].filter((name) => !started.has(name));
  assert.deepEqual(orphans, [], `stopped but never started: ${orphans.join(', ')}`);
});

test('a stop failure never prevents the rest from stopping', () => {
  // Each stop is individually guarded. One that threw out of the loop would
  // leave every later service running in a process that is meant to be gone.
  const stops = [...stopHalf.matchAll(/\b(stop[A-Z][A-Za-z]*)\(\)/g)]
    .map((m) => m[1])
    .filter((name) => name !== 'stopBackgroundServices');
  assert.ok(stops.length > 15, 'the roster is substantial');
  for (const name of stops) {
    assert.match(
      stopHalf,
      new RegExp(`try \\{ ${name}\\(\\); \\} catch`),
      `${name} must be guarded individually`,
    );
  }
});

test('index.js delegates rather than keeping a second copy of the list', () => {
  assert.match(INDEX, /startBackgroundServices\(\{/);
  assert.match(INDEX, /stopBackgroundServices\(\)/);
  // The things that are the PROCESS rather than the roster stay behind.
  for (const kept of ['startServer()', 'startBot()', 'startLeadsBot()', 'startMemoryWatchdog()']) {
    assert.ok(INDEX.includes(kept), `${kept} belongs to the process, not the roster`);
  }
  // And nothing from the roster is started twice.
  assert.ok(!INDEX.includes('startSafetyCoach()'), 'a roster service must not also start in index.js');
  assert.ok(!INDEX.includes('startRetentionWatch()'));
});

test('the roster names what each service may send, not just that it runs', () => {
  // The comments are the point of the file: several of these can message a
  // driver or spend money, and reordering them without knowing which is how a
  // fleet gets texted at three in the morning.
  for (const phrase of ['never to a driver', 'no employment decision', 'DIFFERENT token']) {
    assert.ok(SOURCE.includes(phrase), `the roster should still say: ${phrase}`);
  }
});

test('the module exports exactly the two functions', () => {
  // eslint-disable-next-line global-require
  const mod = require('../services/backgroundServices');
  assert.deepEqual(Object.keys(mod).sort(), ['startBackgroundServices', 'stopBackgroundServices']);
});
