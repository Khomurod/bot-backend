'use strict';

/**
 * The reconcile-only endpoint, and the promise in its name.
 *
 * THE POINT OF THE ROUTE IS WHAT IT CANNOT DO. Reconciliation used to be
 * reachable only through `openRoundAndPost`, so seeing what it would do to the
 * roster meant letting it mint a review round and send the link to a dispatch
 * group. Nobody checks a roster at that price, so nobody checked it.
 *
 * These tests read the route module's own source rather than driving Express,
 * because the guarantee is structural: this handler must never reach the
 * round-minting or sending paths, in any branch, and a test that exercised one
 * happy request would not show that.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RAW = fs.readFileSync(
  path.resolve(__dirname, '../server/routes/raiseRoutes.js'), 'utf8'
);
// Comments EXPLAIN the round-minting path; only code may reach it. Counting
// prose would make this test fail the moment somebody documented the rule.
const SOURCE = RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** The body of one `adminRouter.<verb>('<routePath>', …)` handler. */
function handlerBody(routePath) {
  const start = SOURCE.indexOf(`adminRouter.post('${routePath}'`);
  assert.notEqual(start, -1, `${routePath} must be registered`);
  const next = SOURCE.indexOf('adminRouter.', start + 10);
  return SOURCE.slice(start, next === -1 ? SOURCE.length : next);
}

test('the reconcile route is registered on the ADMIN router, not the public one', () => {
  assert.match(SOURCE, /adminRouter\.post\('\/roster\/reconcile'/,
    'a roster rebuild is not something a dispatcher link may trigger');
  assert.equal(SOURCE.includes("publicRouter.post('/roster/reconcile'"), false);
});

test('the reconcile route cannot mint or send a round, in any branch', () => {
  const body = handlerBody('/roster/reconcile');
  for (const forbidden of ['openRoundAndPost', 'sendNow', 'createRound', 'setRoundEmployeeMessage']) {
    assert.equal(body.includes(forbidden), false,
      `${forbidden} must be unreachable from the reconcile handler`);
  }
  assert.match(body, /reconcileRosterFromBoard/);
});

test('it says so in the response, so a caller never has to infer it', () => {
  assert.match(handlerBody('/roster/reconcile'), /roundSent:\s*false/);
});

test('a dry run is requestable from the body OR the query string', () => {
  const body = handlerBody('/roster/reconcile');
  assert.match(body, /req\.body\?\.dryRun === true/);
  assert.match(body, /req\.query\?\.dryRun/);
  assert.match(body, /apply:\s*!dryRun/,
    'dryRun must reach the service as `apply: false`, not be silently dropped');
});

test('send-now is still the ONLY route that opens a round', () => {
  // If a second one ever appears, this fails and whoever added it has to say
  // why a round can now be sent from somewhere else.
  const minting = [...SOURCE.matchAll(/openRoundAndPost|raise\.sendNow/g)];
  assert.equal(minting.length, 1, 'exactly one route may mint and send a review round');
  assert.match(handlerBody('/send-now'), /sendNow/);
});
