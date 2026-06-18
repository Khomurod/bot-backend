const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function loadClient() {
  const servicePath = path.resolve(__dirname, '../services/datatruckApiService.js');
  const configPath = path.resolve(__dirname, '../config/config.js');
  delete require.cache[servicePath];
  delete require.cache[configPath];
  require.cache[configPath] = {
    exports: { datatruckApiToken: 'test-token', datatruckCompany: 'test-company' },
  };
  return require(servicePath);
}

test('Datatruck client retries a transient server failure and uses a request timeout signal', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) {
      return new Response('temporary', { status: 503, headers: { 'retry-after': '0' } });
    }
    return new Response(JSON.stringify({ results: [{ id: 1 }], next: null }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const client = loadClient();
  const rows = await client.fetchAllPages('drivers/list/');
  assert.deepEqual(rows, [{ id: 1 }]);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(calls[0].options.headers.Authorization, 'Token test-token');
});

test('Datatruck client does not retry permanent authentication failures', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return new Response('unauthorized', { status: 401 });
  };

  const client = loadClient();
  await assert.rejects(client.fetchAllPages('drivers/list/'), /Datatruck API 401/);
  assert.equal(calls, 1);
});
