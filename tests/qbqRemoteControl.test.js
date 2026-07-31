/**
 * The phone remote, driven end to end with TWO concurrent live clients against
 * a real HTTP server: a presenter holding an SSE stream, and a remote posting
 * commands. Nothing here is mocked below the route layer, so pairing, command
 * de-duplication, two-way state sync, expiry and disconnect are exercised over
 * the wire exactly as a browser would.
 *
 * The presenter client stands in for the deck: it applies each command the way
 * qbq-remote-link.js does (through the component's public next/prev and the
 * shared zoom module) and reports the resulting state back. That is what proves
 * the remote and the local controls share one source of truth.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { withQbqServer, jsonHeaders } = require('./helpers/qbqRouteHarness');

/**
 * Minimal SSE reader: resolves events as they arrive, no framework.
 *
 * An event is delivered to at most ONE consumer — either a waiter whose
 * predicate matches it, or the pending queue. Leaving a delivered event in the
 * queue would let a later next() re-read it and silently pass on a stale frame.
 */
function openStream(base, token) {
  const pending = [];
  const waiters = [];
  const controller = new AbortController();

  function deliver(event) {
    const index = waiters.findIndex((w) => w.predicate(event));
    if (index < 0) {
      pending.push(event);
      return;
    }
    const [waiter] = waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(event);
  }

  const ready = fetch(`${base}/api/qbq/stream?token=${encodeURIComponent(token)}`, {
    headers: { Accept: 'text/event-stream' },
    signal: controller.signal,
  }).then(async (res) => {
    if (!res.ok) throw new Error(`stream failed: ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let cut;
          while ((cut = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const line = frame.split('\n').find((l) => l.startsWith('data: '));
            if (!line) continue;              // ": ok" / ": hb" comments
            deliver(JSON.parse(line.slice(6)));
          }
        }
      } catch (err) { /* aborted with the test */ }
    })();
    return res;
  });

  return {
    ready,
    pending,
    /** Wait for the next event matching `predicate`, checking what already arrived. */
    next(predicate, timeoutMs = 2000) {
      const index = pending.findIndex(predicate);
      if (index >= 0) return Promise.resolve(pending.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve };
        waiter.timer = setTimeout(() => {
          const at = waiters.indexOf(waiter);
          if (at >= 0) waiters.splice(at, 1);
          reject(new Error('timed out waiting for SSE event'));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
    close() { controller.abort(); },
  };
}

const postJson = (base, path, body, token) => fetch(base + path, {
  method: 'POST',
  headers: token ? { ...jsonHeaders, Authorization: `Bearer ${token}` } : jsonHeaders,
  body: JSON.stringify(body || {}),
});

/**
 * Stand-in for the deck: holds the same central state the component does and
 * reports it back after every command, local or remote.
 */
function createPresenterDeck(base, presenterToken, total = 28) {
  const deck = {
    slide: 0,
    total,
    zoom: 1,
    applied: [],
    lastCommandId: 0,
    next() { deck.slide = Math.min(deck.total - 1, deck.slide + 1); },
    prev() { deck.slide = Math.max(0, deck.slide - 1); },
    setZoom(delta) {
      const raw = Math.round((deck.zoom + delta) / 0.1) * 0.1;
      deck.zoom = Math.min(1.6, Math.max(0.6, Math.round(raw * 100) / 100));
    },
    apply(command) {
      // Same second guard qbq-remote-link.js uses.
      if (command.id <= deck.lastCommandId) return false;
      deck.lastCommandId = command.id;
      deck.applied.push(command.action);
      if (command.action === 'next') deck.next();
      else if (command.action === 'prev') deck.prev();
      else if (command.action === 'zoomIn') deck.setZoom(0.1);
      else if (command.action === 'zoomOut') deck.setZoom(-0.1);
      else if (command.action === 'reset') deck.zoom = 1;
      return true;
    },
    report() {
      return postJson(base, '/api/qbq/state',
        { slide: deck.slide, total: deck.total, zoom: deck.zoom }, presenterToken);
    },
  };
  return deck;
}

test('presenter and remote pair, then Prev/Next/zoom/reset all work', async () => {
  await withQbqServer({}, async (base) => {
    // ── Presenter opens a session and starts listening.
    const session = await (await postJson(base, '/api/qbq/session')).json();
    assert.equal(session.code.length, 6);
    assert.match(session.code, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/, 'unambiguous alphabet');

    const presenterStream = openStream(base, session.presenterToken);
    await presenterStream.ready;
    const deck = createPresenterDeck(base, session.presenterToken);
    await deck.report();

    // ── Remote pairs with the code it was told.
    const paired = await (await postJson(base, '/api/qbq/pair', { code: session.code })).json();
    assert.ok(paired.remoteToken, 'pairing returns a token');
    assert.equal(paired.sessionId, session.sessionId);
    assert.equal(paired.state.slide, 0);
    assert.equal(paired.state.total, 28, 'the remote sees the presenter current state at once');

    const remoteStream = openStream(base, paired.remoteToken);
    await remoteStream.ready;
    await remoteStream.next((e) => e.type === 'state');

    let seq = 0;
    const tap = async (action) => {
      seq += 1;
      const res = await postJson(base, '/api/qbq/command', { action, seq }, paired.remoteToken);
      const body = await res.json();
      const command = await presenterStream.next((e) => e.type === 'command');
      deck.apply(command);
      await deck.report();
      await remoteStream.next((e) => e.type === 'state');
      return body;
    };

    // Next advances exactly one slide; Prev goes back exactly one.
    await tap('next');
    assert.equal(deck.slide, 1);
    await tap('next');
    assert.equal(deck.slide, 2);
    await tap('prev');
    assert.equal(deck.slide, 1);

    // Zoom scales the presentation itself and reports a real percentage.
    await tap('zoomIn');
    assert.equal(Math.round(deck.zoom * 100), 110);
    await tap('zoomIn');
    assert.equal(Math.round(deck.zoom * 100), 120);
    await tap('zoomOut');
    assert.equal(Math.round(deck.zoom * 100), 110);
    await tap('reset');
    assert.equal(deck.zoom, 1);

    assert.deepEqual(deck.applied, ['next', 'next', 'prev', 'zoomIn', 'zoomIn', 'zoomOut', 'reset']);

    presenterStream.close();
    remoteStream.close();
  });
});

test('zoom clamps to 60%–160% and never distorts past the limits', async () => {
  await withQbqServer({}, async (base) => {
    const session = await (await postJson(base, '/api/qbq/session')).json();
    const stream = openStream(base, session.presenterToken);
    await stream.ready;
    const deck = createPresenterDeck(base, session.presenterToken);
    const paired = await (await postJson(base, '/api/qbq/pair', { code: session.code })).json();

    let seq = 0;
    const tap = async (action) => {
      seq += 1;
      await postJson(base, '/api/qbq/command', { action, seq }, paired.remoteToken);
      deck.apply(await stream.next((e) => e.type === 'command'));
      await deck.report();
    };

    for (let i = 0; i < 12; i++) await tap('zoomIn');
    assert.equal(Math.round(deck.zoom * 100), 160, 'upper limit');
    for (let i = 0; i < 20; i++) await tap('zoomOut');
    assert.equal(Math.round(deck.zoom * 100), 60, 'lower limit');
    await tap('reset');
    assert.equal(deck.zoom, 1, 'reset returns to the fitted size');

    stream.close();
  });
});

test('local keyboard navigation on the deck updates the remote', async () => {
  await withQbqServer({}, async (base) => {
    const session = await (await postJson(base, '/api/qbq/session')).json();
    const deck = createPresenterDeck(base, session.presenterToken);
    const paired = await (await postJson(base, '/api/qbq/pair', { code: session.code })).json();
    const remoteStream = openStream(base, paired.remoteToken);
    await remoteStream.ready;
    await remoteStream.next((e) => e.type === 'state');

    // No command is sent — this is the presenter pressing ArrowRight locally.
    deck.next();
    deck.next();
    deck.next();
    await deck.report();

    const update = await remoteStream.next((e) => e.type === 'state' && e.state.slide === 3);
    assert.equal(update.state.slide, 3, 'the phone follows local navigation');
    assert.equal(update.state.total, 28);

    remoteStream.close();
  });
});

test('a repeated seq never navigates twice', async () => {
  await withQbqServer({}, async (base) => {
    const session = await (await postJson(base, '/api/qbq/session')).json();
    const stream = openStream(base, session.presenterToken);
    await stream.ready;
    const deck = createPresenterDeck(base, session.presenterToken);
    const paired = await (await postJson(base, '/api/qbq/pair', { code: session.code })).json();

    const send = (action, seq) => postJson(base, '/api/qbq/command', { action, seq }, paired.remoteToken);

    const first = await (await send('next', 1)).json();
    assert.equal(first.applied, true);
    deck.apply(await stream.next((e) => e.type === 'command'));

    // The same tap delivered again — a retry, a flaky network, a double touch.
    for (const seq of [1, 1]) {
      const retry = await (await send('next', seq)).json();
      assert.equal(retry.applied, false, `seq ${seq} must be ignored`);
      assert.equal(retry.reason, 'DUPLICATE');
    }
    // A malformed counter is rejected outright rather than treated as a tap.
    for (const seq of [0, -3, 1.5, 'x', null]) {
      const res = await send('next', seq);
      assert.equal(res.status, 400, `seq ${JSON.stringify(seq)} must be refused`);
      assert.equal((await res.json()).code, 'INVALID_SEQ');
    }
    assert.equal(deck.slide, 1, 'still exactly one slide of movement');

    // A genuinely new tap still works.
    const second = await (await send('next', 2)).json();
    assert.equal(second.applied, true);
    deck.apply(await stream.next((e) => e.type === 'command'));
    assert.equal(deck.slide, 2);

    stream.close();
  });
});

test('rapid taps advance exactly once each, in order', async () => {
  await withQbqServer({}, async (base) => {
    const session = await (await postJson(base, '/api/qbq/session')).json();
    const stream = openStream(base, session.presenterToken);
    await stream.ready;
    const deck = createPresenterDeck(base, session.presenterToken);
    const paired = await (await postJson(base, '/api/qbq/pair', { code: session.code })).json();

    // Ten taps fired without waiting, the way a thumb on a phone actually does.
    const taps = [];
    for (let seq = 1; seq <= 10; seq++) {
      taps.push(postJson(base, '/api/qbq/command', { action: 'next', seq }, paired.remoteToken));
    }
    const results = await Promise.all((await Promise.all(taps)).map((r) => r.json()));
    assert.equal(results.filter((r) => r.applied).length, 10, 'each distinct tap counts once');

    for (let i = 0; i < 10; i++) {
      deck.apply(await stream.next((e) => e.type === 'command'));
    }
    assert.equal(deck.slide, 10, 'ten taps, ten slides — no skipping');
    assert.equal(deck.applied.length, 10);

    stream.close();
  });
});

test('an invalid or expired code cannot control the presentation', async () => {
  await withQbqServer({}, async (base) => {
    const session = await (await postJson(base, '/api/qbq/session')).json();

    for (const code of ['ABCDEF', '000000', '', 'nope', session.code + 'X', null]) {
      const res = await postJson(base, '/api/qbq/pair', { code });
      assert.ok(res.status === 400 || res.status === 429, `code ${JSON.stringify(code)} must fail`);
    }

    // A code is single-use: the correct one works once, then never again.
    const ok = await postJson(base, '/api/qbq/pair', { code: session.code });
    assert.equal(ok.status, 200);
    const replay = await postJson(base, '/api/qbq/pair', { code: session.code });
    assert.equal(replay.status, 400, 'a consumed code cannot pair a second device');
  });
});

test('a command with no token, a stale token, or an unknown action is refused', async () => {
  await withQbqServer({}, async (base) => {
    const session = await (await postJson(base, '/api/qbq/session')).json();
    const paired = await (await postJson(base, '/api/qbq/pair', { code: session.code })).json();

    assert.equal((await postJson(base, '/api/qbq/command', { action: 'next', seq: 1 })).status, 401);
    assert.equal(
      (await postJson(base, '/api/qbq/command', { action: 'next', seq: 1 }, 'not-a-real-token')).status,
      401,
    );
    // A presenter token is not a remote token.
    assert.equal(
      (await postJson(base, '/api/qbq/command', { action: 'next', seq: 1 }, session.presenterToken)).status,
      403,
    );
    for (const action of ['delete', 'goTo', '', null, 'NEXT']) {
      const res = await postJson(base, '/api/qbq/command', { action, seq: 99 }, paired.remoteToken);
      assert.equal(res.status, 400, `action ${JSON.stringify(action)}`);
    }
  });
});

test('a disconnected remote stops controlling, and the presenter keeps presenting', async () => {
  await withQbqServer({}, async (base) => {
    const session = await (await postJson(base, '/api/qbq/session')).json();
    const stream = openStream(base, session.presenterToken);
    await stream.ready;
    const paired = await (await postJson(base, '/api/qbq/pair', { code: session.code })).json();
    await stream.next((e) => e.type === 'remote' && e.connected === true);

    assert.equal((await postJson(base, '/api/qbq/disconnect', {}, paired.remoteToken)).status, 200);
    await stream.next((e) => e.type === 'remote' && e.connected === false);

    const after = await postJson(base, '/api/qbq/command', { action: 'next', seq: 5 }, paired.remoteToken);
    assert.equal(after.status, 401, 'a dropped remote must not still drive the deck');

    // The presenter's own session is untouched and can pair a new phone.
    const fresh = await (await postJson(base, '/api/qbq/session/code', {}, session.presenterToken)).json();
    assert.equal(fresh.code.length, 6);
    assert.equal((await postJson(base, '/api/qbq/pair', { code: fresh.code })).status, 200);

    stream.close();
  });
});

test('ending the presenter session kills the remote with it', async () => {
  await withQbqServer({}, async (base) => {
    const session = await (await postJson(base, '/api/qbq/session')).json();
    const paired = await (await postJson(base, '/api/qbq/pair', { code: session.code })).json();

    assert.equal((await postJson(base, '/api/qbq/disconnect', {}, session.presenterToken)).status, 200);

    const after = await postJson(base, '/api/qbq/command', { action: 'next', seq: 1 }, paired.remoteToken);
    assert.equal(after.status, 401, 'an ended session controls nothing');
    assert.equal((await postJson(base, '/api/qbq/state', { slide: 3 }, session.presenterToken)).status, 401);
  });
});

test('reconnecting the remote restores the presenter current slide', async () => {
  await withQbqServer({}, async (base) => {
    const session = await (await postJson(base, '/api/qbq/session')).json();
    const deck = createPresenterDeck(base, session.presenterToken);
    const paired = await (await postJson(base, '/api/qbq/pair', { code: session.code })).json();

    for (let i = 0; i < 7; i++) deck.next();
    deck.setZoom(0.3);
    await deck.report();

    // The phone's tab is refreshed: same token from sessionStorage, new stream.
    const reconnected = openStream(base, paired.remoteToken);
    await reconnected.ready;
    const snapshot = await reconnected.next((e) => e.type === 'state');
    assert.equal(snapshot.state.slide, 7, 'the first frame carries the current slide');
    assert.equal(snapshot.state.total, 28);
    assert.equal(Math.round(snapshot.state.zoom * 100), 130);

    // And it can still drive the deck after reconnecting.
    const res = await postJson(base, '/api/qbq/command', { action: 'prev', seq: 1 }, paired.remoteToken);
    assert.equal((await res.json()).applied, true);

    reconnected.close();
  });
});

test('two presenter sessions never control each other', async () => {
  await withQbqServer({}, async (base) => {
    const a = await (await postJson(base, '/api/qbq/session')).json();
    const b = await (await postJson(base, '/api/qbq/session')).json();
    assert.notEqual(a.sessionId, b.sessionId);
    assert.notEqual(a.presenterToken, b.presenterToken);
    assert.notEqual(a.code, b.code);

    const remoteA = await (await postJson(base, '/api/qbq/pair', { code: a.code })).json();
    assert.equal(remoteA.sessionId, a.sessionId, 'a code binds only to the deck that issued it');

    const deckA = createPresenterDeck(base, a.presenterToken);
    const deckB = createPresenterDeck(base, b.presenterToken);
    deckA.slide = 4;
    deckB.slide = 19;
    await deckA.report();
    await deckB.report();

    const streamA = openStream(base, remoteA.remoteToken);
    await streamA.ready;
    const state = await streamA.next((e) => e.type === 'state');
    assert.equal(state.state.slide, 4, "remote A must not see deck B's slide");

    streamA.close();
  });
});

test('pairing attempts are rate limited', async () => {
  await withQbqServer({}, async (base) => {
    let limited = 0;
    for (let i = 0; i < 14; i++) {
      const res = await postJson(base, '/api/qbq/pair', { code: 'ZZZZZZ' });
      if (res.status === 429) {
        limited += 1;
        assert.ok(res.headers.get('retry-after'), 'a 429 must say when to retry');
      }
    }
    assert.ok(limited > 0, 'brute forcing a 6-character code must be throttled');
  });
});
