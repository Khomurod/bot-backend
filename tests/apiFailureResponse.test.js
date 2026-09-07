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

/**
 * Silence the handler's own console.error while asserting on the response.
 * Returns whatever `fn` returns, so an async body can be awaited by the caller
 * — the restore then happens in the promise's finally, not before it runs.
 */
function quiet(fn) {
  const { error } = console;
  console.error = () => {};
  const restore = () => { console.error = error; };
  let result;
  try {
    result = fn();
  } catch (err) {
    restore();
    throw err;
  }
  // A promise restores when it settles; anything else, right now.
  if (result && typeof result.finally === 'function') return result.finally(restore);
  restore();
  return result;
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

/**
 * A MALFORMED REQUEST IS NOT A SERVER FAULT. express.json() runs ahead of every
 * route — before the auth middleware — so a bad body is the failure most likely
 * to reach the terminal handler, and it used to answer
 * `500 { error: 'Server error' }`. That sends whoever is debugging to the server
 * logs for something the request did, and it makes a real 500 harder to spot
 * among the noise.
 */
test('a malformed body answers 400 and names the body, not the server', () => {
  const res = fakeRes();
  const parseError = Object.assign(new SyntaxError('Unexpected token } in JSON at position 1'), {
    status: 400,
    statusCode: 400,
    type: 'entity.parse.failed',
    body: '{}}',
  });
  quiet(() => createErrorHandler()(parseError, { method: 'POST', originalUrl: '/api/recruiters' }, res, () => {}));
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'Request body is not valid JSON');
  assert.match(res.body.detail, /Unexpected token/, 'the parser detail is still reported');
});

test('the other body-parser refusals keep their own status and wording', () => {
  for (const [type, status, expected] of [
    ['entity.too.large', 413, 'Request body is too large'],
    ['encoding.unsupported', 415, 'Request body encoding is not supported'],
    ['charset.unsupported', 415, 'Request body charset is not supported'],
    ['request.aborted', 400, 'Request was aborted before it finished'],
  ]) {
    const res = fakeRes();
    const error = Object.assign(new Error('raw parser text'), { status, type });
    quiet(() => createErrorHandler()(error, { method: 'POST', originalUrl: '/api/x' }, res, () => {}));
    assert.equal(res.statusCode, status, type);
    assert.equal(res.body.error, expected, type);
  }
});

test('a service error that escapes keeps the status it chose', () => {
  // Several services here throw with an explicit statusCode — registerSmsMirror
  // (400 for a missing field), handleTelegramSmsReply (404 for no mirror). Their
  // own routes catch these today, but one escaping must not become a 500.
  for (const [statusCode, message] of [[400, 'driverPhone is required'], [404, 'No auto-SMS mirror found for that message']]) {
    const res = fakeRes();
    quiet(() => createErrorHandler()(
      Object.assign(new Error(message), { statusCode }),
      { method: 'POST', originalUrl: '/api/internal/facebook/register-sms-mirror' },
      res,
      () => {},
    ));
    assert.equal(res.statusCode, statusCode);
    assert.equal(res.body.error, message);
  }
});

test('only 4xx is adopted — a 5xx or a nonsense status still reads as a server fault', () => {
  // A 502 from a failed SMS send IS a server-side failure, and an error must
  // never be able to talk its way into a 2xx or a redirect.
  for (const status of [502, 500, 200, 204, 302, 0, -1, 700, NaN, 'abc', null, undefined]) {
    const res = fakeRes();
    quiet(() => createErrorHandler()(
      Object.assign(new Error('SMS send failed'), { statusCode: status }),
      { method: 'POST', originalUrl: '/api/x' },
      res,
      () => {},
    ));
    assert.equal(res.statusCode, 500, `statusCode=${String(status)}`);
    assert.equal(res.body.error, 'Server error', `statusCode=${String(status)}`);
  }
});

test('a genuine bug is still a 500, not talked down to a 400', () => {
  const res = fakeRes();
  quiet(() => createErrorHandler()(
    new TypeError('getDaysUntilBirthday is not a function'),
    { method: 'GET', originalUrl: '/api/groups' },
    res,
    () => {},
  ));
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'Server error');
});

test('a DATABASE failure outranks any status on the error', () => {
  // An unreachable database is not the request's fault, whatever status is
  // attached — the panel must still see DB_UNAVAILABLE and its 503.
  const res = fakeRes();
  const error = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
    code: 'ECONNREFUSED',
    statusCode: 400,
  });
  quiet(() => createErrorHandler()(error, { method: 'GET', originalUrl: '/api/x' }, res, () => {}));
  assert.equal(res.body.code, FAILURE_CODES.DB_UNAVAILABLE);
  assert.equal(res.statusCode, 503, 'the database status, not the 400 on the error');
});

test('sendFailure keeps its caller\'s intent — only the terminal handler infers', () => {
  // Every other caller passes a status deliberately; inferring there would
  // silently rewrite responses that are already correct.
  const res = fakeRes();
  const error = Object.assign(new Error('nope'), { statusCode: 404 });
  quiet(() => sendFailure(res, error, { message: 'Failed to load recruiters' }));
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'Failed to load recruiters');
});

/**
 * Through a REAL express.json(), because the point of the fix is what a live
 * request gets. A hand-made SyntaxError proves the handler; only the parser
 * itself proves the wiring — that the error reaches the terminal handler at all,
 * and does so BEFORE any auth middleware could have answered 401.
 */
test('a live request with a broken body gets 400 JSON from the real parser', async () => {
  const express = require('express');
  const http = require('node:http');

  const app = express();
  app.use(express.json());
  app.post('/api/thing', (req, res) => res.json({ ok: true, got: req.body }));
  app.use(createErrorHandler());

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/thing`;
  const post = (body) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  try {
    await quiet(async () => {
      const broken = await post('{\\"to\\":\\"x\\"}');
      assert.equal(broken.status, 400, 'a malformed body is the request\'s fault');
      const payload = await broken.json();
      assert.equal(payload.error, 'Request body is not valid JSON');
      assert.ok(payload.detail, 'and the parser said why');

      // The happy path is untouched.
      const fine = await post(JSON.stringify({ to: '+15550000000' }));
      assert.equal(fine.status, 200);
      assert.deepEqual((await fine.json()).got, { to: '+15550000000' });
    });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
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
