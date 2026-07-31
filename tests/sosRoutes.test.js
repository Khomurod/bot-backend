/**
 * SOS routes — wiring, auth gating, error mapping, rate limiting, CSV export,
 * and REAL/TEST mode separation at the HTTP layer: /api/sos/* passes
 * isTest=false into the service, /api/sos/test/* passes isTest=true, admin
 * clear-test and clear-real are distinct endpoints with distinct confirmation
 * phrases. The service layer is stubbed (its logic is covered by
 * sosScoring/sosAggregation/sosContent tests and the Pg suites).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const express = require('express');

const SERVICE_PATH = path.resolve(__dirname, '../services/sosAssessment/index.js');
const ROUTES_PATH = path.resolve(__dirname, '../server/routes/sosRoutes.js');

function serviceError(code, message, status, extra = {}) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  err.extra = extra;
  return err;
}

function defaultServiceStub(calls) {
  const track = (name, args) => calls && calls.push({ name, args });
  return {
    getMeta: async (isTest) => { track('getMeta', { isTest }); return { open: true, isTest: isTest === true, contentVersion: 1, departments: [], dispatchTeams: [{ id: 1, name: 'Team Alpha' }] }; },
    getQuestionnaire: async (dept, isTest) => { track('getQuestionnaire', { dept, isTest }); return { contentVersion: 1, department: dept, questions: [] }; },
    submitAssessment: async (input) => { track('submitAssessment', { isTest: input.isTest }); return { resultToken: 'a'.repeat(32), result: { language: 'uz' } }; },
    getResultByToken: async (token, isTest) => { track('getResultByToken', { token, isTest }); throw serviceError('NOT_FOUND', 'Result not found', 404); },
    getPublicSummary: async (isTest) => { track('getPublicSummary', { isTest }); return { open: true, total: 0, company: {}, departments: [], dispatchTeams: [] }; },
    getAdminStatus: async () => ({ open: true, testOpen: true, real: { total: 2 }, test: { total: 1 } }),
    getAdminSubmissionDetail: async (id) => (id === 7
      ? { id: 7, fullName: 'Jane Doe', isTest: false, answers: [] }
      : Promise.reject(serviceError('NOT_FOUND', 'Submission not found', 404))),
    listSubmissions: async ({ mode }) => {
      track('listSubmissions', { mode });
      const all = [
        {
          id: 1, isTest: false, fullName: '=cmd|danger', department: 'hr', dispatchTeamName: null, language: 'uz',
          primaryPattern: 'ownership', secondaryPattern: null, duplicateCount: 1,
          patternScores: { victim: 0, complaint: 0, waiting: 1, blame: 0, ownership: 6, builder: 3 },
          createdAt: new Date('2026-07-30T12:00:00Z'),
        },
        {
          id: 2, isTest: true, fullName: 'Test Person', department: 'hr', dispatchTeamName: null, language: 'uz',
          primaryPattern: 'builder', secondaryPattern: null, duplicateCount: 1,
          patternScores: { victim: 0, complaint: 0, waiting: 0, blame: 0, ownership: 4, builder: 6 },
          createdAt: new Date('2026-07-30T13:00:00Z'),
        },
      ];
      if (mode === 'all') return all;
      return all.filter((r) => r.isTest === (mode === 'test'));
    },
    setOpen: async (open, isTest) => { track('setOpen', { open, isTest }); return { isOpen: isTest ? true : open, testIsOpen: isTest ? open : true, updatedAt: new Date('2026-07-30T12:00:00Z') }; },
    deleteSubmission: async (id) => id === 7,
    clearSubmissions: async (isTest) => { track('clearSubmissions', { isTest }); return isTest ? 3 : 9; },
  };
}

function loadRouters(stubOverrides = {}, calls) {
  delete require.cache[ROUTES_PATH];
  delete require.cache[SERVICE_PATH];
  require.cache[SERVICE_PATH] = {
    id: SERVICE_PATH,
    filename: SERVICE_PATH,
    loaded: true,
    exports: { ...defaultServiceStub(calls), ...stubOverrides },
  };
  const routers = require(ROUTES_PATH);
  delete require.cache[ROUTES_PATH];
  delete require.cache[SERVICE_PATH];
  return routers;
}

/** Mounts routers exactly like server/api.js: admin, then test, then real. */
async function withServer(stubOverrides, fn, calls) {
  const { publicRouter, publicTestRouter, adminRouter } = loadRouters(stubOverrides, calls);
  const app = express();
  app.use(express.json());
  const fakeAuth = (req, res, next) => {
    if (req.headers.authorization === 'Bearer good-token') { req.admin = { username: 'tester' }; return next(); }
    return res.status(401).json({ error: 'Unauthorized' });
  };
  app.use('/api/sos/admin', fakeAuth, adminRouter);
  app.use('/api/sos/test', publicTestRouter);
  app.use('/api/sos', publicRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

const authHeaders = { Authorization: 'Bearer good-token', 'Content-Type': 'application/json' };

test('real public endpoints pass isTest=false; test endpoints pass isTest=true', async () => {
  const calls = [];
  await withServer({}, async (base) => {
    for (const [url, expected] of [
      ['/api/sos/meta', false],
      ['/api/sos/test/meta', true],
      ['/api/sos/questionnaire?department=hr', false],
      ['/api/sos/test/questionnaire?department=hr', true],
      ['/api/sos/summary', false],
      ['/api/sos/test/summary', true],
    ]) {
      const res = await fetch(base + url);
      assert.equal(res.status, 200, url);
      const last = calls[calls.length - 1];
      assert.equal(last.args.isTest, expected, `${url} must run in isTest=${expected}`);
    }

    for (const [url, expected] of [['/api/sos/submissions', false], ['/api/sos/test/submissions', true]]) {
      const res = await fetch(base + url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      assert.equal(res.status, 201, url);
      const last = calls[calls.length - 1];
      assert.equal(last.name, 'submitAssessment');
      assert.equal(last.args.isTest, expected);
    }

    for (const [url, expected] of [
      [`/api/sos/results/${'f'.repeat(32)}`, false],
      [`/api/sos/test/results/${'f'.repeat(32)}`, true],
    ]) {
      const res = await fetch(base + url);
      assert.equal(res.status, 404, 'stubbed token is unknown');
      const last = calls[calls.length - 1];
      assert.equal(last.args.isTest, expected, `${url}: token lookup must stay in its own mode`);
    }
  }, calls);
});

test('every admin endpoint is blocked without a valid token', async () => {
  await withServer({}, async (base) => {
    const routes = [
      ['GET', '/api/sos/admin/status'],
      ['PUT', '/api/sos/admin/status'],
      ['GET', '/api/sos/admin/submissions'],
      ['GET', '/api/sos/admin/submissions/7'],
      ['DELETE', '/api/sos/admin/submissions/7'],
      ['POST', '/api/sos/admin/clear-test'],
      ['POST', '/api/sos/admin/clear-real'],
    ];
    for (const [method, url] of routes) {
      const res = await fetch(base + url, { method });
      assert.equal(res.status, 401, `${method} ${url}`);
    }
  });
});

test('closed questionnaire maps to 403 with the closed flag (both modes)', async () => {
  await withServer({
    getQuestionnaire: async () => { throw serviceError('SOS_CLOSED', 'closed', 403, { closed: true }); },
  }, async (base) => {
    for (const url of ['/api/sos/questionnaire?department=hr', '/api/sos/test/questionnaire?department=hr']) {
      const res = await fetch(base + url);
      assert.equal(res.status, 403, url);
      assert.equal((await res.json()).closed, true);
    }
  });
});

test('submission maps duplicate and stale-content responses', async () => {
  await withServer({
    submitAssessment: async (input) => {
      if (input.confirmDuplicate !== true) {
        throw serviceError('DUPLICATE', 'exists', 409, { duplicate: true, submittedAt: '2026-07-30' });
      }
      return { resultToken: 'b'.repeat(32), result: { language: 'ru' } };
    },
  }, async (base) => {
    const body = { fullName: 'Jane', department: 'hr', language: 'ru', contentVersion: 1, answers: [] };
    const dup = await fetch(`${base}/api/sos/submissions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(dup.status, 409);
    assert.equal((await dup.json()).duplicate, true);

    const ok = await fetch(`${base}/api/sos/submissions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, confirmDuplicate: true }),
    });
    assert.equal(ok.status, 201);
  });

  await withServer({
    submitAssessment: async () => { throw serviceError('STALE_CONTENT', 'reload', 409, { staleContent: true }); },
  }, async (base) => {
    const res = await fetch(`${base}/api/sos/submissions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).staleContent, true);
  });
});

test('rate limiting is per mode: exhausting the real bucket leaves the test bucket usable', async () => {
  await withServer({}, async (base) => {
    let lastStatus = 0;
    for (let i = 0; i < 13; i += 1) {
      const res = await fetch(`${base}/api/sos/submissions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      lastStatus = res.status;
    }
    assert.equal(lastStatus, 429, 'real bucket exhausted');
    const testRes = await fetch(`${base}/api/sos/test/submissions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(testRes.status, 201, 'test bucket is independent');
  });
});

test('admin list filters by mode, defaults to real, and rejects unknown modes', async () => {
  const calls = [];
  await withServer({}, async (base) => {
    const real = await (await fetch(`${base}/api/sos/admin/submissions`, { headers: authHeaders })).json();
    assert.equal(real.mode, 'real');
    assert.ok(real.submissions.every((r) => r.isTest === false));

    const testRows = await (await fetch(`${base}/api/sos/admin/submissions?mode=test`, { headers: authHeaders })).json();
    assert.equal(testRows.mode, 'test');
    assert.ok(testRows.submissions.every((r) => r.isTest === true));

    const all = await (await fetch(`${base}/api/sos/admin/submissions?mode=all`, { headers: authHeaders })).json();
    assert.equal(all.submissions.length, 2);

    const bad = await fetch(`${base}/api/sos/admin/submissions?mode=everything`, { headers: authHeaders });
    assert.equal(bad.status, 400);
  }, calls);
});

test('CSV export is mode-labeled (filename + column) and formula-safe', async () => {
  await withServer({}, async (base) => {
    const csv = await fetch(`${base}/api/sos/admin/submissions?format=csv&mode=test`, { headers: authHeaders });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.match(csv.headers.get('content-disposition'), /sos-submissions-test\.csv/);
    const text = await csv.text();
    assert.ok(text.startsWith('id,mode,full_name'), text.slice(0, 60));
    assert.ok(text.includes(',test,'), 'mode column present');

    const combined = await fetch(`${base}/api/sos/admin/submissions?format=csv&mode=all`, { headers: authHeaders });
    assert.match(combined.headers.get('content-disposition'), /sos-submissions-all\.csv/);
    const combinedText = await combined.text();
    assert.ok(combinedText.includes("'=cmd|danger"), 'formula injection not neutralized');
    assert.ok(combinedText.includes(',real,') && combinedText.includes(',test,'), 'combined export labels each row');
  });
});

test('clear-test and clear-real are separate endpoints with separate phrases', async () => {
  const calls = [];
  await withServer({}, async (base) => {
    // Wrong/foreign phrases are rejected — the real phrase cannot clear test.
    for (const [url, phrase] of [
      ['/api/sos/admin/clear-test', 'DELETE ALL REAL SUBMISSIONS'],
      ['/api/sos/admin/clear-test', 'delete test data'],
      ['/api/sos/admin/clear-real', 'DELETE TEST DATA'],
      ['/api/sos/admin/clear-real', ''],
    ]) {
      const res = await fetch(base + url, { method: 'POST', headers: authHeaders, body: JSON.stringify({ confirm: phrase }) });
      assert.equal(res.status, 400, `${url} must reject phrase "${phrase}"`);
    }
    assert.equal(calls.filter((c) => c.name === 'clearSubmissions').length, 0, 'nothing cleared on bad phrases');

    const testClear = await fetch(`${base}/api/sos/admin/clear-test`, {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ confirm: 'DELETE TEST DATA' }),
    });
    assert.equal(testClear.status, 200);
    assert.deepEqual(await testClear.json(), { deleted: 3, mode: 'test' });

    const realClear = await fetch(`${base}/api/sos/admin/clear-real`, {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ confirm: 'DELETE ALL REAL SUBMISSIONS' }),
    });
    assert.equal(realClear.status, 200);
    assert.deepEqual(await realClear.json(), { deleted: 9, mode: 'real' });

    assert.deepEqual(
      calls.filter((c) => c.name === 'clearSubmissions').map((c) => c.args.isTest),
      [true, false],
      'each endpoint clears exactly its own mode',
    );
  }, calls);
});

test('admin status toggle targets one mode; detail/delete behave as before', async () => {
  const calls = [];
  await withServer({}, async (base) => {
    const real = await fetch(`${base}/api/sos/admin/status`, {
      method: 'PUT', headers: authHeaders, body: JSON.stringify({ open: false }),
    });
    assert.equal(real.status, 200);
    const testMode = await fetch(`${base}/api/sos/admin/status`, {
      method: 'PUT', headers: authHeaders, body: JSON.stringify({ open: false, mode: 'test' }),
    });
    assert.equal(testMode.status, 200);
    assert.deepEqual(
      calls.filter((c) => c.name === 'setOpen').map((c) => c.args.isTest),
      [false, true],
    );
    const badMode = await fetch(`${base}/api/sos/admin/status`, {
      method: 'PUT', headers: authHeaders, body: JSON.stringify({ open: false, mode: 'all' }),
    });
    assert.equal(badMode.status, 400);

    assert.equal((await fetch(`${base}/api/sos/admin/submissions/7`, { headers: authHeaders })).status, 200);
    assert.equal((await fetch(`${base}/api/sos/admin/submissions/8`, { headers: authHeaders })).status, 404);
    assert.equal((await fetch(`${base}/api/sos/admin/submissions/7`, { method: 'DELETE', headers: authHeaders })).status, 200);
    assert.equal((await fetch(`${base}/api/sos/admin/submissions/9`, { method: 'DELETE', headers: authHeaders })).status, 404);
  }, calls);
});

// ─────────────── dispatch teams over HTTP ───────────────
// The six authoritative teams (services/sosAssessment/dispatchTeams.js) must
// survive the HTTP boundary unchanged: the submit body carries the team KEY, the
// admin filter resolves a key to the exact stored NAME, an unknown key is a 400
// rather than a silently unfiltered list, and the CSV carries the exact name.

test('a submission passes the dispatch team KEY through to the service', async () => {
  const calls = [];
  await withServer({
    submitAssessment: async (input) => {
      calls.push({ name: 'submitAssessment', args: { dispatchTeamKey: input.dispatchTeamKey } });
      return { resultToken: 'c'.repeat(32), result: { language: 'uz' } };
    },
  }, async (base) => {
    const res = await fetch(`${base}/api/sos/submissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fullName: 'Dispatcher One', department: 'dispatch', dispatchTeamKey: 'team_4',
        language: 'uz', contentVersion: 1, answers: [],
      }),
    });
    assert.equal(res.status, 201);
    assert.equal(calls[0].args.dispatchTeamKey, 'team_4');
  }, calls);
});

test('the admin team filter resolves a key to the exact stored team name', async () => {
  const seen = [];
  await withServer({
    listSubmissions: async (filters) => { seen.push(filters); return []; },
  }, async (base) => {
    for (const [key, name] of [
      ['team_1', 'Anthony / Allen / Scott'],
      ['team_2', 'Charles / Leo / Steven'],
      ['team_3', 'Smith / Colin / Kevin'],
      ['team_4', 'Franky / Sam / Ali'],
      ['team_5', 'Tony / Andy / Max'],
      ['team_6', 'Aaron / Jack'],
    ]) {
      const res = await fetch(`${base}/api/sos/admin/submissions?mode=all&team=${key}`, { headers: authHeaders });
      assert.equal(res.status, 200, key);
      assert.equal(seen[seen.length - 1].dispatchTeamName, name, key);
    }
    // No team filter means no team constraint at all.
    await fetch(`${base}/api/sos/admin/submissions?mode=all`, { headers: authHeaders });
    assert.equal(seen[seen.length - 1].dispatchTeamName, undefined);
  });
});

test('an unknown team key is a 400, never an unfiltered list', async () => {
  const seen = [];
  await withServer({
    listSubmissions: async (filters) => { seen.push(filters); return []; },
  }, async (base) => {
    for (const bad of ['team_7', 'Team%20Alpha', '1', 'nope']) {
      const res = await fetch(`${base}/api/sos/admin/submissions?mode=all&team=${bad}`, { headers: authHeaders });
      assert.equal(res.status, 400, bad);
    }
    assert.deepEqual(seen, [], 'a rejected filter must never reach the database');
  });
});

test('the CSV export carries the exact team name', async () => {
  await withServer({
    listSubmissions: async () => ([{
      id: 5, isTest: false, fullName: 'Dispatcher One', department: 'dispatch',
      dispatchTeamName: 'Smith / Colin / Kevin', language: 'uz',
      primaryPattern: 'builder', secondaryPattern: null, duplicateCount: 1,
      patternScores: { victim: 0, complaint: 0, waiting: 0, blame: 0, ownership: 4, builder: 6 },
      createdAt: new Date('2026-07-31T09:00:00Z'),
    }]),
  }, async (base) => {
    const res = await fetch(`${base}/api/sos/admin/submissions?mode=real&format=csv`, { headers: authHeaders });
    assert.equal(res.status, 200);
    const csv = await res.text();
    assert.match(csv, /Smith \/ Colin \/ Kevin/);
  });
});
