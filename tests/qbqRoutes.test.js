/**
 * /qbq hosting and persistent editing at the HTTP layer.
 *
 * Covers what a browser actually experiences: the deck comes back whole on a
 * direct hit and on a refresh, the remote page is reachable, the client assets
 * resolve, neighbouring routes are untouched, and saving is gated, validated
 * and sanitized before anything reaches the database.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  authHeaders, jsonHeaders, createDbStub, withQbqServer,
} = require('./helpers/qbqRouteHarness');

// ─── Hosting ────────────────────────────────────────────────────────────────

test('GET /qbq returns the whole presentation, and a refresh returns the same', async () => {
  await withQbqServer({}, async (base) => {
    const first = await fetch(`${base}/qbq`);
    assert.equal(first.status, 200);
    assert.match(first.headers.get('content-type') || '', /text\/html/);
    const html = await first.text();

    // The deck itself, not a shell that fetches it later.
    assert.match(html, /<deck-stage[^>]*width="1920"/);
    // Anchored to line start: the component's own doc comment contains example
    // <section data-label=…> lines that are not slides.
    assert.equal((html.match(/^<section data-label=/gm) || []).length, 28, 'all 28 slides');
    assert.match(html, /customElements\.define\('deck-stage'/);

    // A refresh is the same request; nothing here is single-use or stateful.
    const second = await fetch(`${base}/qbq`);
    assert.equal(second.status, 200);
    assert.equal(await second.text(), html, 'refresh must return an identical document');
  });
});

test('/qbq is never cached, so a saved edit shows up on the next refresh', async () => {
  await withQbqServer({}, async (base) => {
    const res = await fetch(`${base}/qbq`);
    assert.match(res.headers.get('cache-control') || '', /no-store/);
  });
});

test('/qbq/ with a trailing slash serves the deck too', async () => {
  await withQbqServer({}, async (base) => {
    const res = await fetch(`${base}/qbq/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<deck-stage/);
  });
});

test('the hosted document swaps the offline file-save editor for the server one', async () => {
  await withQbqServer({}, async (base) => {
    const html = await (await fetch(`${base}/qbq`)).text();

    // The offline save-to-disk path must not ship to a hosted page.
    assert.ok(!html.includes('showSaveFilePicker'), 'offline file picker must be gone');
    assert.ok(!html.includes('QBQ:LOCAL-SAVE-START'), 'sentinels are consumed, not served');

    for (const asset of ['qbq-auth.js', 'qbq-edit.js', 'qbq-zoom.js', 'qbq-remote-link.js']) {
      assert.ok(html.includes(`/qbq/assets/${asset}`), `missing ${asset}`);
    }
    assert.match(html, /window\.__QBQ__ = \{/);

    // Everything else the deck needs is still present and untouched.
    assert.ok(html.includes('id="sos-fs"'), 'fullscreen control');
    assert.ok(html.includes('data-anim="rise"'), 'animations');
    assert.ok(html.includes('data-speaker-notes='), 'speaker notes');
    assert.ok(html.includes("@font-face") || html.includes('IBM Plex Sans'), 'embedded typography');
  });
});

test('saved overrides are inlined into the document, so an edit never flashes', async () => {
  const db = createDbStub();
  db.rows.set('s11.0', {
    elementPath: 's11.0', slideIndex: 11, content: 'Yangi matn', updatedAt: new Date(),
  });
  await withQbqServer({ db }, async (base) => {
    const html = await (await fetch(`${base}/qbq`)).text();
    assert.match(html, /"elementPath":"s11\.0"/);
    assert.match(html, /"content":"Yangi matn"/);
  });
});

test('a database outage still serves the deck, just with the template wording', async () => {
  const db = createDbStub({ failList: true });
  await withQbqServer({ db }, async (base) => {
    const res = await fetch(`${base}/qbq`);
    assert.equal(res.status, 200, 'the deck must reach the projector regardless');
    const html = await res.text();
    assert.match(html, /<deck-stage/);
    assert.match(html, /"overrides":\[\]/);
  });
});

test('inlined override content cannot break out of its <script> tag', async () => {
  const db = createDbStub();
  db.rows.set('s1.0', {
    elementPath: 's1.0',
    slideIndex: 1,
    content: '</script><script>window.pwned=1</script>',
    updatedAt: new Date(),
  });
  await withQbqServer({ db }, async (base) => {
    const html = await (await fetch(`${base}/qbq`)).text();
    // The payload is allowed to appear as DATA inside the JSON island — what it
    // must never do is close the tag and become a second <script> element.
    assert.ok(!html.includes('<script>window.pwned'), 'payload must not become a script element');
    assert.ok(!html.includes('</script><script>window.pwned'), 'payload must not break out of the tag');
    assert.match(html, /\\u003C\/script\\u003E/, '"<" and ">" are escaped in the JSON island');
  });
});

test('GET /qbq/remote serves the controller and its refresh works', async () => {
  await withQbqServer({}, async (base) => {
    for (const url of [`${base}/qbq/remote`, `${base}/qbq/remote/`]) {
      const res = await fetch(url);
      assert.equal(res.status, 200, url);
      const html = await res.text();
      assert.match(html, /Masofaviy boshqaruv/);
      assert.match(html, /data-act="next"/);
      assert.match(html, /data-act="prev"/);
      assert.match(html, /data-act="zoomIn"/);
      assert.match(html, /data-act="zoomOut"/);
      assert.match(html, /data-act="reset"/);
      // No external dependency of any kind.
      assert.ok(!/src="https?:\/\//.test(html), 'no external script');
      assert.ok(!/href="https?:\/\//.test(html), 'no external stylesheet or font');
    }
  });
});

test('the client assets referenced by the page actually load', async () => {
  await withQbqServer({}, async (base) => {
    for (const asset of ['qbq-auth.js', 'qbq-edit.js', 'qbq-zoom.js', 'qbq-remote-link.js']) {
      const res = await fetch(`${base}/qbq/assets/${asset}`);
      assert.equal(res.status, 200, asset);
      assert.match(res.headers.get('content-type') || '', /javascript/, asset);
      assert.ok((await res.text()).length > 200, `${asset} looks empty`);
    }
  });
});

test('the assets mount cannot be walked out of, and remote.html is not inside it', async () => {
  await withQbqServer({}, async (base) => {
    const escapes = [
      '/qbq/assets/../remote.html',
      '/qbq/assets/%2e%2e/remote.html',
      '/qbq/assets/../../api.js',
      '/qbq/assets/remote.html',
    ];
    for (const url of escapes) {
      const res = await fetch(base + url, { redirect: 'manual' });
      assert.ok(res.status >= 300, `${url} must not serve a file (got ${res.status})`);
      if (res.status === 200) assert.fail(`${url} served content`);
    }
  });
});

test('mounting /qbq does not intercept the admin SPA, questions, answers or the API', async () => {
  await withQbqServer({}, async (base) => {
    for (const url of ['/admin', '/admin/users', '/questions', '/questions/test', '/answers', '/answers/x']) {
      const res = await fetch(base + url);
      assert.equal(res.status, 200, url);
      assert.equal(await res.text(), '<html>spa</html>', `${url} must still reach the SPA`);
    }
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
  });
});

// ─── Persistent editing ─────────────────────────────────────────────────────

test('reading saved edits is public', async () => {
  const db = createDbStub();
  db.rows.set('s2.1', { elementPath: 's2.1', slideIndex: 2, content: 'Salom', updatedAt: new Date() });
  await withQbqServer({ db }, async (base) => {
    const res = await fetch(`${base}/api/qbq/content`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.overrides.length, 1);
    assert.equal(body.overrides[0].content, 'Salom');
  });
});

test('a full admin can save an edited text element', async () => {
  const db = createDbStub();
  await withQbqServer({ db }, async (base) => {
    const res = await fetch(`${base}/api/qbq/content`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ elementPath: 's12.1.0', content: 'Ikki oy o‘tib, Jeykob lavozimga ko‘tarildi.' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.saved.elementPath, 's12.1.0');
    assert.equal(body.saved.slideIndex, 12, 'slide index is derived from the path');
    assert.equal(body.saved.content, 'Ikki oy o‘tib, Jeykob lavozimga ko‘tarildi.');

    const call = db.calls.find((c) => c.name === 'upsertOverride');
    assert.equal(call.input.adminId, 42, 'the saving admin is recorded');
  });
});

test('a saved change appears the next time /qbq is opened', async () => {
  const db = createDbStub();
  await withQbqServer({ db }, async (base) => {
    await fetch(`${base}/api/qbq/content`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ elementPath: 's3.2', content: 'Saqlangan matn' }),
    });
    const html = await (await fetch(`${base}/qbq`)).text();
    assert.match(html, /"content":"Saqlangan matn"/);
    assert.match(html, /"elementPath":"s3\.2"/);
  });
});

test('unauthenticated and non-full-admin callers cannot save', async () => {
  const db = createDbStub();
  await withQbqServer({ db }, async (base) => {
    const anonymous = await fetch(`${base}/api/qbq/content`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({ elementPath: 's1.0', content: 'hack' }),
    });
    assert.equal(anonymous.status, 401);

    const weak = await fetch(`${base}/api/qbq/content`, {
      method: 'PUT',
      headers: { ...jsonHeaders, Authorization: 'Bearer weak-token' },
      body: JSON.stringify({ elementPath: 's1.0', content: 'hack' }),
    });
    assert.equal(weak.status, 403);

    assert.equal(db.calls.filter((c) => c.name === 'upsertOverride').length, 0,
      'a rejected caller must never reach the database');
  });
});

test('invalid element ids are rejected before any write', async () => {
  const db = createDbStub();
  await withQbqServer({ db }, async (base) => {
    const bad = ['', 'nope', 's11', 's01.0', 's11.0; DROP TABLE qbq_presentation_edits', null, 12];
    for (const elementPath of bad) {
      const res = await fetch(`${base}/api/qbq/content`, {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({ elementPath, content: 'Matn' }),
      });
      assert.equal(res.status, 400, `elementPath ${JSON.stringify(elementPath)}`);
      assert.equal((await res.json()).code, 'INVALID_ELEMENT_PATH');
    }
    assert.equal(db.calls.filter((c) => c.name === 'upsertOverride').length, 0);
  });
});

test('unsafe HTML is sanitized to plain text, and empty/oversized content is refused', async () => {
  const db = createDbStub();
  await withQbqServer({ db }, async (base) => {
    const res = await fetch(`${base}/api/qbq/content`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        elementPath: 's4.0',
        content: '<img src=x onerror=alert(1)>Xavfsiz<script>alert(2)</script>',
      }),
    });
    assert.equal(res.status, 200);
    const saved = (await res.json()).saved.content;
    assert.equal(saved, 'Xavfsizalert(2)');
    assert.ok(!saved.includes('<'), 'no markup may be stored');
    assert.ok(!saved.includes('onerror'), 'no event handler may be stored');

    for (const [content, code] of [['   ', 'CONTENT_EMPTY'], ['x'.repeat(4001), 'CONTENT_TOO_LONG']]) {
      const bad = await fetch(`${base}/api/qbq/content`, {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({ elementPath: 's4.1', content }),
      });
      assert.equal(bad.status, 400);
      assert.equal((await bad.json()).code, code);
    }
  });
});

test('a failed save preserves the previously saved version', async () => {
  const db = createDbStub();
  await withQbqServer({ db }, async (base) => {
    const put = (content) => fetch(`${base}/api/qbq/content`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ elementPath: 's5.0', content }),
    });

    assert.equal((await put('Birinchi matn')).status, 200);

    // Every rejection path, then a database failure — none may disturb the row.
    assert.equal((await put('')).status, 400);
    assert.equal((await put('x'.repeat(4001))).status, 400);
    assert.equal((await put('<br>')).status, 400, 'markup-only collapses to empty');

    const content = await (await fetch(`${base}/api/qbq/content`)).json();
    assert.equal(content.overrides[0].content, 'Birinchi matn',
      'the earlier value must survive every failed save');
  });
});

test('a database write failure answers 500 and keeps the old row', async () => {
  const failing = createDbStub({ failUpsert: true });
  failing.rows.set('s6.0', { elementPath: 's6.0', slideIndex: 6, content: 'Eski matn', updatedAt: new Date() });

  await withQbqServer({ db: failing }, async (base) => {
    const res = await fetch(`${base}/api/qbq/content`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ elementPath: 's6.0', content: 'Yangi matn' }),
    });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).code, 'SAVE_FAILED');

    const after = await (await fetch(`${base}/api/qbq/content`)).json();
    assert.equal(after.overrides[0].content, 'Eski matn');
  });
});

test('the hosted page still ships double-click editing and the Save button', async () => {
  await withQbqServer({}, async (base) => {
    const editor = await (await fetch(`${base}/qbq/assets/qbq-edit.js`)).text();
    assert.match(editor, /addEventListener\('dblclick'/, 'double-click editing must exist');
    assert.match(editor, /contenteditable/, 'the element becomes editable');
    assert.match(editor, /id = 'sos-save'/, 'the Save pill keeps its identity and styling');
    assert.match(editor, /'\/api\/qbq\/content'/, 'Save writes to the server, not to a file');
    assert.match(editor, /Saqlash/, 'Uzbek Save label');
    assert.match(editor, /Saqlandi/, 'Uzbek success label');
    // Persistence must not be faked client-side.
    assert.ok(!/localStorage\.setItem\(\s*'qbq\.(content|overrides)/.test(editor));
  });
});
