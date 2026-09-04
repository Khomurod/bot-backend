/**
 * `GET /remote` — the presenter remote page, at the HTTP layer.
 *
 * The whole feature is one public route serving one file, so what matters here
 * is what a phone actually receives: a 200 with HTML, on both spellings of the
 * path, uncached, with the two things the page cannot work without — the
 * `#rcRemote` container and the `wzl/rc/` topic namespace the presentation
 * publishes to. A remote that renders but talks on the wrong namespace fails
 * silently in front of a room, which is why the namespace is asserted as a
 * literal rather than trusted.
 *
 * No env, no database, no network: the router requires only express and path.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const { createRemoteRoutes, REMOTE_HTML } = require('../server/routes/remoteRoutes');

/**
 * The route mounted the way server/api.js mounts it — ahead of stand-ins for
 * the neighbours it must not swallow, and with no auth middleware anywhere,
 * because a projector's QR code cannot carry an admin session.
 */
async function withRemoteServer(fn) {
  const app = express();
  app.use(createRemoteRoutes());
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.get(['/admin', '/admin/*'], (req, res) => res.type('html').send('<html>spa</html>'));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('GET /remote serves the remote page', async () => {
  await withRemoteServer(async (base) => {
    const res = await fetch(`${base}/remote`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/html/);

    const html = await res.text();
    assert.match(html, /id="rcRemote"/, 'the remote container must be in the document');
    assert.ok(html.includes("RC_NS = 'wzl/rc/'"), 'the topic namespace must match the presentation');
  });
});

test('the page carries the protocol the presentation speaks', async () => {
  await withRemoteServer(async (base) => {
    const html = await (await fetch(`${base}/remote`)).text();

    // Brokers, in the presentation's order — a phone and a laptop that pick
    // different brokers never see each other.
    const brokers = html.match(/wss:\/\/[^'"]+/g) || [];
    assert.deepEqual(brokers, [
      'wss://broker.emqx.io:8084/mqtt',
      'wss://broker.hivemq.com:8884/mqtt',
      'wss://test.mosquitto.org:8081/mqtt',
    ], 'broker list and order are fixed by the presentation');

    // Both topics, and every action the deck understands.
    assert.ok(html.includes("rrTopic('cmd')"), 'publishes to the cmd topic');
    assert.ok(html.includes("rrTopic('state')"), 'subscribes to the state topic');
    for (const action of ['hello', 'ping', 'next', 'prev', 'first', 'last', 'goto', 'fullscreen', 'minimize', 'bye']) {
      assert.ok(
        html.includes(`'${action}'`) || html.includes(`"${action}"`),
        `the pad must be able to send ${action}`,
      );
    }
  });
});

test('both pairing paths are wired: a code on load and a code that arrives later', async () => {
  // CI has no browser, so this guards the wiring rather than the behaviour.
  // The behaviour itself was verified in Chromium against a local broker: a
  // fresh load of /remote#c=1234 pairs with no taps, and a hash change on an
  // already-open page (a camera app reusing the tab) pairs too.
  await withRemoteServer(async (base) => {
    const html = await (await fetch(`${base}/remote`)).text();
    assert.ok(html.includes('rrCodeFromUrl()'), 'the code is read out of the URL');
    assert.ok(html.includes("addEventListener('hashchange'"), 'and again when the hash changes');
    assert.ok(html.includes('rrJoinWith(code)'), 'a code found on load joins immediately');
    // Both hash and query spellings, because a QR reader may rewrite one.
    assert.ok(/\[#\?&\]c=/.test(html), 'c= is accepted from the hash or the query');
  });
});

test('the page is self-contained: nothing to load before it can pair', async () => {
  await withRemoteServer(async (base) => {
    const html = await (await fetch(`${base}/remote`)).text();
    // No stylesheet, font, image or eagerly loaded script from anywhere.
    assert.ok(!/<script[^>]+src=/i.test(html), 'no <script src> in the served document');
    assert.ok(!/<link[^>]+href="https?:/i.test(html), 'no external stylesheet or font');
    assert.ok(!/<img[^>]+src="https?:/i.test(html), 'no remote image');
    // The one CDN reference is the QR fallback, injected at runtime and only
    // when the browser has no BarcodeDetector — never on the pairing path.
    assert.ok(html.includes('cdn.jsdelivr.net'), 'the jsQR fallback is available');
    assert.ok(html.includes('BarcodeDetector'), 'and is only a fallback');
  });
});

test('a stale copy can never be served after a deploy', async () => {
  await withRemoteServer(async (base) => {
    const res = await fetch(`${base}/remote`);
    assert.match(res.headers.get('cache-control') || '', /no-cache/);
  });
});

test('/remote/ with a trailing slash works too', async () => {
  await withRemoteServer(async (base) => {
    const res = await fetch(`${base}/remote/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /id="rcRemote"/);
  });
});

test('HEAD /remote answers 200, so an uptime check does not report it down', async () => {
  await withRemoteServer(async (base) => {
    const res = await fetch(`${base}/remote`, { method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/html/);
  });
});

test('it needs no authentication — a projector QR cannot carry a session', async () => {
  await withRemoteServer(async (base) => {
    // No Authorization header of any kind, and no token in the URL.
    const res = await fetch(`${base}/remote#c=1234`);
    assert.equal(res.status, 200);
  });
});

test('it does not shadow its neighbours', async () => {
  await withRemoteServer(async (base) => {
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    assert.match(await (await fetch(`${base}/admin`)).text(), /spa/);
    // And nothing else under /remote is exposed by mounting one route.
    assert.equal((await fetch(`${base}/remote/../server/api.js`)).status, 404);
  });
});

test('the file the route points at is the one in the repository', () => {
  // Guards a rename or a move: the route resolves a path at require time, so a
  // wrong path is a 404 in production and nothing at all in review.
  assert.equal(REMOTE_HTML, path.join(__dirname, '..', 'server', 'public', 'remote.html'));
  assert.ok(fs.existsSync(REMOTE_HTML), 'server/public/remote.html must exist');
});
