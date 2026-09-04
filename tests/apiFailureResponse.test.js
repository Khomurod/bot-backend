/**
 * How a failed request answers.
 *
 * Two failure modes are being fixed here, and both misled whoever was looking
 * at the admin panel:
 *
 *   - endpoints that answered `200 { states: [] }` on a database error, so an
 *     outage was indistinguishable from an empty fleet;
 *   - errors escaping a handler, which produced Express's default HTML stack
 *     page. The admin's fetch layer saw HTML where JSON belonged and reported
 *     "this tab is running an outdated version" — a wrong diagnosis for a
 *     server fault, and one that sent people to reload instead of to the logs.
 *
 * The codes asserted here are the same vocabulary admin/src/utils/pageFailure.js
 * maps to wording, so a change on either side that breaks the pairing shows up.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { sendFailure, createErrorHandler } = require('../server/middleware/failureResponse');
const { FAILURE_CODES } = require('../lib/database/failureClassification');

/** Minimal Express-shaped response recorder. */
function fakeRes() {
  const res = {
    statusCode: null,
    body: null,
    headersSent: false,
    status(code) { res.statusCode = code; return res; },
    json(payload) { res.body = payload; res.headersSent = true; return res; },
  };
  return res;
}

/** Silence the handler's own console.error while asserting on the response. */
function quiet(fn) {
  const { error } = console;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = error;
  }
}

const pgError = (message, code) => Object.assign(new Error(message), { code });

test('a database outage answers 503 with a code the panel understands', () => {
  const res = fakeRes();
  quiet(() => sendFailure(res, pgError('Connection terminated unexpectedly', '08006'), {
    message: 'Failed to load trailer states',
  }));
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, FAILURE_CODES.DB_UNAVAILABLE);
  assert.match(res.body.error, /database could not be reached/i);
  // The underlying text is passed through, never swallowed.
  assert.match(res.body.detail, /Connection terminated/);
  assert.equal(res.body.retryable, true);
});

test('a usage ceiling answers DB_QUOTA, distinct from an outage', () => {
  const res = fakeRes();
  quiet(() => sendFailure(res, new Error('monthly data transfer quota exceeded')));
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, FAILURE_CODES.DB_QUOTA);
  assert.equal(res.body.retryable, false);
});

test('the tag database/pool.js attaches is honoured without re-classifying', () => {
  const res = fakeRes();
  const tagged = new Error('anything at all');
  tagged.dbFailure = {
    code: FAILURE_CODES.DB_PERMISSION, status: 503, message: 'Credentials rejected.', retryable: false,
  };
  quiet(() => sendFailure(res, tagged));
  assert.equal(res.body.code, FAILURE_CODES.DB_PERMISSION);
  assert.equal(res.body.error, 'Credentials rejected.');
});

test('an application error keeps its 500 and the caller\'s own wording', () => {
  const res = fakeRes();
  quiet(() => sendFailure(res, pgError('duplicate key value violates unique constraint', '23505'), {
    message: 'Failed to save the trailer',
  }));
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'Failed to save the trailer');
  assert.equal(res.body.code, undefined, 'a bug must not be labelled a database outage');
  assert.match(res.body.detail, /duplicate key/);
});

test('a very long driver message is truncated rather than dumped', () => {
  const res = fakeRes();
  quiet(() => sendFailure(res, new Error('x'.repeat(5000))));
  assert.ok(res.body.detail.length <= 500);
});

// ─── the terminal handler ────────────────────────────────────────────────────

test('an error escaping a handler answers JSON, not an HTML stack page', () => {
  const res = fakeRes();
  const handler = createErrorHandler();
  quiet(() => handler(new Error('boom'), { method: 'GET', originalUrl: '/api/x' }, res, () => {
    throw new Error('next() must not be called when nothing was sent yet');
  }));
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'Server error');
  assert.match(res.body.detail, /boom/);
});

test('an escaping database error is classified by the terminal handler too', () => {
  const res = fakeRes();
  const handler = createErrorHandler();
  quiet(() => handler(pgError('sorry, too many clients already'), { method: 'GET', originalUrl: '/api/y' }, res, () => {}));
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, FAILURE_CODES.DB_TIMEOUT);
});

test('a response already sent is handed to Express instead of written twice', () => {
  const res = fakeRes();
  res.headersSent = true;
  let passed = null;
  const handler = createErrorHandler();
  handler(new Error('late failure'), { method: 'GET', originalUrl: '/api/z' }, res, (err) => { passed = err; });
  assert.equal(res.body, null, 'nothing may be written after headers');
  assert.match(passed.message, /late failure/);
});
