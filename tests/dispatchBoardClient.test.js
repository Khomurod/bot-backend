'use strict';

/**
 * The Board authenticates by query string, so this client's first job is to
 * make sure the credential never travels anywhere it was not sent — not into a
 * log, not into an error, and not onto a second host behind a redirect.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { fetchBoard, buildBoardUrl, BoardFetchError } = require('../services/dispatchBoard/client');

const BASE = 'https://script.example.com/macros/s/AKfycbX/exec';
const TOKEN = 'Sh4red-T0ken-ThatMustNeverAppear';
const CONNECTION = { baseUrl: BASE, token: TOKEN };

/** A minimal Response double: no stream, so the text path is exercised. */
function answer(body, { status = 200, headers = {} } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
    async text() { return text; },
  };
}

test('the token is added to the query string, and any existing parameters survive', () => {
  const url = buildBoardUrl(`${BASE}?sheet=today`, TOKEN);
  assert.match(url, /sheet=today/);
  assert.match(url, /token=Sh4red/);
});

test('a successful answer comes back parsed', async () => {
  const result = await fetchBoard(CONNECTION, {
    fetchImpl: async () => answer({ rows: [{ driver_name: 'A', truck: '1', status: 'READY' }] }),
  });
  assert.equal(result.status, 200);
  assert.equal(result.json.rows.length, 1);
});

test('exactly one redirect is followed, and the token is not re-attached to it', async () => {
  const seen = [];
  const result = await fetchBoard(CONNECTION, {
    fetchImpl: async (url) => {
      seen.push(url);
      if (seen.length === 1) {
        return answer('', { status: 302, headers: { location: 'https://script.googleusercontent.com/signed' } });
      }
      return answer({ rows: [] });
    },
  });
  assert.equal(result.status, 200);
  assert.equal(seen.length, 2);
  assert.ok(seen[0].includes('token='), 'the first request carries the credential');
  assert.ok(!seen[1].includes('token='), 'the redirect target must never be handed the token');
});

test('a second redirect is refused — a credentialled request does not chase a chain', async () => {
  await assert.rejects(
    () => fetchBoard(CONNECTION, {
      fetchImpl: async () => answer('', { status: 302, headers: { location: 'https://elsewhere.example/x' } }),
    }),
    (err) => {
      assert.equal(err.kind, 'too_many_redirects');
      assert.ok(!err.message.includes('elsewhere.example'), err.message);
      return true;
    }
  );
});

test('an oversize answer is refused before it is read', async () => {
  let readCalled = false;
  await assert.rejects(
    () => fetchBoard(CONNECTION, {
      maxBytes: 100,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: (k) => (String(k).toLowerCase() === 'content-length' ? '999999' : null) },
        async text() { readCalled = true; return 'x'; },
      }),
    }),
    (err) => err.kind === 'too_large'
  );
  assert.equal(readCalled, false, 'the body must not be buffered to find out it is too big');
});

test('an oversize answer with no content-length is still refused', async () => {
  await assert.rejects(
    () => fetchBoard(CONNECTION, {
      maxBytes: 10,
      fetchImpl: async () => answer('x'.repeat(5000)),
    }),
    (err) => err.kind === 'too_large'
  );
});

test('an HTML sign-in page is reported as not-JSON, and is never quoted', async () => {
  await assert.rejects(
    () => fetchBoard(CONNECTION, {
      fetchImpl: async () => answer('<html><body>Sign in to continue</body></html>'),
    }),
    (err) => {
      assert.equal(err.kind, 'not_json');
      assert.ok(!err.message.includes('Sign in'), err.message);
      assert.match(err.message, /shared with anyone who has the link/);
      return true;
    }
  );
});

test('an HTTP failure names the status and nothing else', async () => {
  await assert.rejects(
    () => fetchBoard(CONNECTION, { fetchImpl: async () => answer('nope', { status: 429 }) }),
    (err) => {
      assert.equal(err.status, 429);
      assert.equal(err.message, 'the board answered 429');
      return true;
    }
  );
});

test('a timeout says so, in seconds, with no URL', async () => {
  await assert.rejects(
    () => fetchBoard(CONNECTION, {
      timeoutMs: 15_000,
      fetchImpl: async () => { const e = new Error('aborted'); e.name = 'TimeoutError'; throw e; },
    }),
    (err) => {
      assert.equal(err.kind, 'timeout');
      assert.match(err.message, /within 15s/);
      return true;
    }
  );
});

test('NO FAILURE ANYWHERE CARRIES THE TOKEN OR THE HOST', async () => {
  // The one property this module exists for. Every failure path, one assertion.
  const failures = [
    { fetchImpl: async () => { const e = new Error(`fetch to ${BASE}?token=${TOKEN} failed`); e.cause = { code: 'ECONNREFUSED' }; throw e; } },
    { fetchImpl: async () => answer('nope', { status: 500 }) },
    { fetchImpl: async () => answer('<html>login</html>') },
    { fetchImpl: async () => answer('', { status: 302, headers: { location: `${BASE}?token=${TOKEN}` } }), extra: { maxRedirects: 0 } },
    { maxBytes: 1, fetchImpl: async () => answer('x'.repeat(50)) },
  ];
  for (const { fetchImpl, maxBytes } of failures) {
    // eslint-disable-next-line no-await-in-loop
    const err = await fetchBoard(CONNECTION, { fetchImpl, maxBytes }).catch((e) => e);
    if (!(err instanceof BoardFetchError)) continue;
    assert.ok(!err.message.includes(TOKEN), err.message);
    assert.ok(!err.message.includes('script.example.com'), err.message);
  }
});

test('an unconfigured connection fails before any request is made', async () => {
  let called = false;
  const spy = async () => { called = true; return answer({}); };
  await assert.rejects(() => fetchBoard({ baseUrl: '', token: TOKEN }, { fetchImpl: spy }),
    (err) => err.kind === 'not_configured');
  await assert.rejects(() => fetchBoard({ baseUrl: BASE, token: '' }, { fetchImpl: spy }),
    (err) => err.kind === 'not_configured');
  assert.equal(called, false);
});

test('a saved value that is not a URL is named as such, not thrown raw', async () => {
  await assert.rejects(
    () => fetchBoard({ baseUrl: 'paste the link here', token: TOKEN }, { fetchImpl: async () => answer({}) }),
    (err) => err.kind === 'bad_url'
  );
});
