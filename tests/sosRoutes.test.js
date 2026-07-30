/**
 * SOS routes — wiring, auth gating, error mapping, rate limiting, and CSV
 * export. The service layer is stubbed (its logic is covered by
 * sosScoring/sosAggregation/sosContent tests); these tests prove the HTTP
 * contract: admin endpoints are unreachable without auth, public endpoints
 * never require it, and service errors map to their status codes.
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

function defaultServiceStub() {
  return {
    getMeta: async () => ({ open: true, contentVersion: 1, departments: [], dispatchTeams: [{ id: 1, name: 'Team Alpha' }] }),
    getQuestionnaire: async () => ({ contentVersion: 1, department: 'hr', questions: [{ key: 'hr_q01', position: 1, text: { uz: 'u', ru: 'r', en: 'e' }, options: [{ key: 'hr_q01_a', text: { uz: 'u', ru: 'r', en: 'e' } }] }] }),
    submitAssessment: async () => ({ resultToken: 'a'.repeat(32), result: { language: 'uz', primary: { pattern: 'ownership' } } }),
    getResultByToken: async () => { throw serviceError('NOT_FOUND', 'Result not found', 404); },
    getPublicSummary: async () => ({ open: true, total: 0, company: { suppressed: true }, departments: [], dispatchTeams: [] }),
    getAdminStatus: async () => ({ open: true, total: 2, byDepartment: { hr: 2 }, byTeam: [], lastSubmissionAt: null }),
    getAdminSubmissionDetail: async (id) => (id === 7
      ? { id: 7, fullName: 'Jane Doe', answers: [] }
      : Promise.reject(serviceError('NOT_FOUND', 'Submission not found', 404))),
    listSubmissions: async () => ([{
      id: 1, fullName: '=cmd|danger', department: 'hr', dispatchTeamName: null, language: 'uz',
      primaryPattern: 'ownership', secondaryPattern: null, duplicateCount: 1,
      patternScores: { victim: 0, complaint: 0, waiting: 1, blame: 0, ownership: 6, builder: 3 },
      createdAt: new Date('2026-07-30T12:00:00Z'),
    }]),
    setOpen: async (open) => ({ isOpen: open, updatedAt: new Date('2026-07-30T12:00:00Z') }),
    deleteSubmission: async (id) => id === 7,
    clearAllSubmissions: async () => 3,
  };
}

function loadRouters(stubOverrides = {}) {
  delete require.cache[ROUTES_PATH];
  delete require.cache[SERVICE_PATH];
  require.cache[SERVICE_PATH] = {
    id: SERVICE_PATH,
    filename: SERVICE_PATH,
    loaded: true,
    exports: { ...defaultServiceStub(), ...stubOverrides },
  };
  const routers = require(ROUTES_PATH);
  delete require.cache[ROUTES_PATH];
  delete require.cache[SERVICE_PATH];
  return routers;
}

/** Mounts routers exactly like server/api.js: admin (with auth) BEFORE public. */
async function withServer(stubOverrides, fn) {
  const { publicRouter, adminRouter } = loadRouters(stubOverrides);
  const app = express();
  app.use(express.json());
  const fakeAuth = (req, res, next) => {
    if (req.headers.authorization === 'Bearer good-token') { req.admin = { username: 'tester' }; return next(); }
    return res.status(401).json({ error: 'Unauthorized' });
  };
  app.use('/api/sos/admin', fakeAuth, adminRouter);
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

test('public endpoints work without any authentication', async () => {
  await withServer({}, async (base) => {
    for (const url of ['/api/sos/meta', '/api/sos/questionnaire?department=hr', '/api/sos/summary']) {
      const res = await fetch(base + url);
      assert.equal(res.status, 200, url);
    }
  });
});

test('every admin endpoint is blocked without a valid token', async () => {
  await withServer({}, async (base) => {
    const calls = [
      ['GET', '/api/sos/admin/status'],
      ['PUT', '/api/sos/admin/status'],
      ['GET', '/api/sos/admin/submissions'],
      ['GET', '/api/sos/admin/submissions/7'],
      ['DELETE', '/api/sos/admin/submissions/7'],
      ['POST', '/api/sos/admin/clear'],
    ];
    for (const [method, url] of calls) {
      const res = await fetch(base + url, { method });
      assert.equal(res.status, 401, `${method} ${url}`);
    }
  });
});

test('closed questionnaire maps to 403 with the closed flag', async () => {
  await withServer({
    getQuestionnaire: async () => { throw serviceError('SOS_CLOSED', 'closed', 403, { closed: true }); },
    submitAssessment: async () => { throw serviceError('SOS_CLOSED', 'closed', 403, { closed: true }); },
  }, async (base) => {
    const get = await fetch(`${base}/api/sos/questionnaire?department=hr`);
    assert.equal(get.status, 403);
    assert.equal((await get.json()).closed, true);
    const post = await fetch(`${base}/api/sos/submissions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(post.status, 403);
  });
});

test('submission maps success, duplicate, and stale-content responses', async () => {
  let received = null;
  await withServer({
    submitAssessment: async (input) => {
      received = input;
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
    assert.equal((await ok.json()).resultToken, 'b'.repeat(32));
    assert.equal(received.confirmDuplicate, true);
    assert.ok(received.clientIp, 'client ip forwarded for rate limiting');
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

test('submissions are rate limited per IP', async () => {
  await withServer({}, async (base) => {
    let lastStatus = 0;
    for (let i = 0; i < 13; i += 1) {
      const res = await fetch(`${base}/api/sos/submissions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      lastStatus = res.status;
    }
    assert.equal(lastStatus, 429);
  });
});

test('unknown result token returns 404', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/api/sos/results/${'f'.repeat(32)}`);
    assert.equal(res.status, 404);
  });
});

test('admin list serves JSON and formula-safe CSV', async () => {
  await withServer({}, async (base) => {
    const json = await fetch(`${base}/api/sos/admin/submissions`, { headers: authHeaders });
    assert.equal(json.status, 200);
    assert.equal((await json.json()).submissions[0].fullName, '=cmd|danger');

    const csv = await fetch(`${base}/api/sos/admin/submissions?format=csv`, { headers: authHeaders });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    const text = await csv.text();
    assert.ok(text.startsWith('id,full_name,department'), text.slice(0, 60));
    assert.ok(text.includes("'=cmd|danger"), 'formula injection not neutralized');
  });
});

test('admin detail, delete, status toggle and guarded clear-all', async () => {
  await withServer({}, async (base) => {
    assert.equal((await fetch(`${base}/api/sos/admin/submissions/7`, { headers: authHeaders })).status, 200);
    assert.equal((await fetch(`${base}/api/sos/admin/submissions/8`, { headers: authHeaders })).status, 404);
    assert.equal((await fetch(`${base}/api/sos/admin/submissions/abc`, { headers: authHeaders })).status, 400);

    assert.equal((await fetch(`${base}/api/sos/admin/submissions/7`, { method: 'DELETE', headers: authHeaders })).status, 200);
    assert.equal((await fetch(`${base}/api/sos/admin/submissions/9`, { method: 'DELETE', headers: authHeaders })).status, 404);

    const toggle = await fetch(`${base}/api/sos/admin/status`, {
      method: 'PUT', headers: authHeaders, body: JSON.stringify({ open: false }),
    });
    assert.equal(toggle.status, 200);
    assert.equal((await toggle.json()).open, false);
    const badToggle = await fetch(`${base}/api/sos/admin/status`, {
      method: 'PUT', headers: authHeaders, body: JSON.stringify({ open: 'yes' }),
    });
    assert.equal(badToggle.status, 400);

    const noConfirm = await fetch(`${base}/api/sos/admin/clear`, {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ confirm: 'delete all' }),
    });
    assert.equal(noConfirm.status, 400);
    const cleared = await fetch(`${base}/api/sos/admin/clear`, {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ confirm: 'DELETE ALL' }),
    });
    assert.equal(cleared.status, 200);
    assert.equal((await cleared.json()).deleted, 3);
  });
});
