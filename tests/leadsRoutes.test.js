/**
 * GET /api/leads — the admin Leads page's 45-second poll.
 *
 * WHY THIS IS WORTH A TEST. The hosted database bills every byte it sends
 * back, and each poll read a whole page of leads (about 28 KB) to find, nearly
 * always, the list the page already had. The route now asks the database for a
 * 32-character fingerprint of exactly that page, sends it as a strong ETag, and
 * answers 304 — WITHOUT reading the list — when the browser already holds it.
 *
 * Two traps this file holds shut:
 *
 *   A BROWSER'S CONDITIONAL FETCH ALSO SAYS `Cache-Control: no-cache`. The Fetch
 *   standard switches a request whose script set If-None-Match to "no-store",
 *   which appends `Cache-Control: no-cache` and `Pragma: no-cache`. Express's
 *   `req.fresh` calls every such request stale, so a route built on it passes a
 *   test that leaves the header out and never answers 304 in production.
 *
 *   THE FINGERPRINT IS READ BEFORE THE LIST. A write landing between the two
 *   leaves a newer list under an older ETag, and the next poll re-reads it. The
 *   reverse order could pin a list missing that write under an ETag that keeps
 *   matching.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createLeadsRoutes } = require('../server/routes/leadsRoutes');

const FINGERPRINT = 'f'.repeat(32);
const ETAG = `"${FINGERPRINT}"`;
const LIST = [{
  id: 2, source: 'facebook', full_name: 'Sam Example', email: null,
  phone: '+15550100002', job_title: 'CDL-A Driver', message: null,
  bitrix_status: 'created', created_at: '2026-10-09T12:00:00.000Z',
}];

/** A data layer that records what the route asked it, in order. */
function stubDb({ fingerprint = FINGERPRINT, fail = null } = {}) {
  const calls = [];
  return {
    calls,
    async getLeadListFingerprint(limit, source) {
      calls.push(['fingerprint', limit, source]);
      if (fail === 'fingerprint') throw new Error('connection refused');
      return fingerprint;
    },
    async listLeads(limit, source) {
      calls.push(['list', limit, source]);
      if (fail === 'list') throw new Error('connection refused');
      return LIST;
    },
  };
}

function appWith(db) {
  const app = express();
  app.use(createLeadsRoutes({ db, authMiddleware: (_req, _res, next) => next() }));
  return app;
}

async function get(app, url, headers = {}) {
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { headers });
    return { status: res.status, etag: res.headers.get('etag'), text: await res.text() };
  } finally { server.close(); }
}

test('the first poll gets the list under a strong ETag, the fingerprint read first', async () => {
  const db = stubDb();

  const res = await get(appWith(db), '/api/leads?t=1');

  assert.equal(res.status, 200);
  assert.equal(res.etag, ETAG, 'quoted and without W/: a strong validator');
  assert.deepEqual(JSON.parse(res.text), LIST);
  assert.deepEqual(db.calls, [['fingerprint', 100, null], ['list', 100, null]],
    'fingerprint BEFORE list: the other order can pin a stale list under a matching ETag');
});

test('repeating that ETag gets 304, no body, and no list read', async () => {
  const db = stubDb();
  const app = appWith(db);
  const first = await get(app, '/api/leads?t=1');
  db.calls.length = 0;

  const again = await get(app, '/api/leads?t=2', { 'If-None-Match': first.etag });

  assert.equal(again.status, 304);
  assert.equal(again.text, '');
  assert.equal(again.etag, ETAG, 'a 304 names the validator it confirms');
  assert.deepEqual(db.calls, [['fingerprint', 100, null]], 'the list is not read');
});

test('...also when it arrives the way a browser sends it, with Cache-Control: no-cache', async () => {
  const db = stubDb();

  const res = await get(appWith(db), '/api/leads?t=3', {
    'If-None-Match': ETAG, 'Cache-Control': 'no-cache', Pragma: 'no-cache',
  });

  assert.equal(res.status, 304, 'req.fresh would have said 200 here');
  assert.deepEqual(db.calls.map(([name]) => name), ['fingerprint']);
});

test('an ETag the list has moved on from gets the new list and the new ETag', async () => {
  const db = stubDb({ fingerprint: 'b'.repeat(32) });

  const res = await get(appWith(db), '/api/leads', { 'If-None-Match': `"${'a'.repeat(32)}"` });

  assert.equal(res.status, 200);
  assert.equal(res.etag, `"${'b'.repeat(32)}"`);
  assert.deepEqual(JSON.parse(res.text), LIST);
  assert.deepEqual(db.calls.map(([name]) => name), ['fingerprint', 'list']);
});

test('If-None-Match is compared as HTTP says: a list, a weak form, or *', async () => {
  // Weak comparison matters beyond the RFC: a proxy that compresses a
  // response may hand the browser W/"…" for the strong ETag sent here.
  for (const header of [`"other", ${ETAG}`, `W/${ETAG}`, '*']) {
    const db = stubDb();
    const res = await get(appWith(db), '/api/leads', { 'If-None-Match': header });
    assert.equal(res.status, 304, header);
    assert.deepEqual(db.calls.map(([name]) => name), ['fingerprint'], header);
  }
  for (const header of ['"other"', FINGERPRINT, `"${FINGERPRINT.slice(1)}"`]) {
    const db = stubDb();
    const res = await get(appWith(db), '/api/leads', { 'If-None-Match': header });
    assert.equal(res.status, 200, header);
  }
});

test('the source filter and the limit reach both reads, the same in each', async () => {
  let db = stubDb();
  await get(appWith(db), '/api/leads?source=indeed&limit=25');
  assert.deepEqual(db.calls, [['fingerprint', 25, 'indeed'], ['list', 25, 'indeed']]);

  db = stubDb();
  await get(appWith(db), '/api/leads?source=elsewhere');
  assert.deepEqual(db.calls, [['fingerprint', 100, null], ['list', 100, null]],
    'an unknown source is no filter, as before');
});

test('a failed read answers the same 500 as before', async () => {
  const error = console.error;
  console.error = () => {};
  try {
    for (const fail of ['fingerprint', 'list']) {
      const res = await get(appWith(stubDb({ fail })), '/api/leads');
      assert.equal(res.status, 500, fail);
      assert.deepEqual(JSON.parse(res.text), { error: 'Failed to fetch leads' }, fail);
      assert.notEqual(res.etag, ETAG, `${fail}: a failure never carries the list's ETag`);
    }
  } finally { console.error = error; }
});
