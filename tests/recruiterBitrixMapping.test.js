/**
 * Reading the Bitrix user directory, and turning it into recruiter mappings.
 *
 * `recruiters.bitrix_user_id` is the only link from a Bitrix lead assignment
 * back to a recruiter row, and therefore what decides whose RingCentral number
 * texts a driver. These tests cover the two halves that surround the (pure)
 * matcher: reading `user.get` — including the failure an operator will actually
 * hit, a webhook created without the `user` scope — and applying the plan
 * without ever overwriting an operator's own mapping.
 *
 * THE WEBHOOK URL IS THE CREDENTIAL: a Bitrix inbound webhook authenticates by
 * its path, so a test below asserts it appears nowhere in an API response.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.MANAGEMENT_GROUP_ID ||= '-1001234567890';
process.env.JWT_SECRET ||= 'test-jwt-secret';
process.env.PORT ||= '3001';

const CONFIG_PATH = require.resolve('../config/config');
const BITRIX_PATH = require.resolve('../services/bitrix24Service');
const RC_PATH = require.resolve('../database/ringcentral');
const DIR_PATH = require.resolve('../services/recruiterBitrixMapping/directory');
const MAP_PATH = require.resolve('../services/recruiterBitrixMapping');
const ROUTE_PATH = require.resolve('../server/routes/recruiter/bitrixMappingRoutes');

const WEBHOOK = 'https://wenze.bitrix24.com/rest/1/super-secret-value/';

const bitrixRow = (id, name, lastName, extra = {}) => ({
  ID: String(id), NAME: name, LAST_NAME: lastName, ACTIVE: true, ...extra,
});

/** A fetch that answers user.get pages from a list of bodies. */
function pagedFetch(pages) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const body = pages[calls.length - 1] ?? { result: [] };
    return { ok: body.__http !== false, status: body.__status || 200, json: async () => body };
  };
  return { impl, calls };
}

function loadModules({ enabled = true, webhookUrl = WEBHOOK, recruiters = [], onUpdate } = {}) {
  const realConfig = require('../config/config');
  const seen = { updates: [] };

  require.cache[CONFIG_PATH] = {
    exports: { ...realConfig, bitrix24Enabled: enabled, bitrix24WebhookUrl: webhookUrl },
  };
  require.cache[BITRIX_PATH] = {
    exports: {
      isBitrixConfigured: () => Boolean(enabled && webhookUrl),
      normalizeWebhookBase: (u) => (u ? String(u).replace(/\/?$/, '/') : ''),
    },
  };
  require.cache[RC_PATH] = {
    exports: {
      listRecruitersForAdmin: async () => recruiters,
      updateRecruiter: async (id, payload) => {
        seen.updates.push({ id, payload });
        if (onUpdate) return onUpdate(id, payload);
        return { id, ...payload };
      },
    },
  };

  delete require.cache[DIR_PATH];
  delete require.cache[MAP_PATH];
  const directory = require(DIR_PATH);
  const mapping = require(MAP_PATH);
  const restore = () => {
    for (const p of [CONFIG_PATH, BITRIX_PATH, RC_PATH, DIR_PATH, MAP_PATH]) delete require.cache[p];
  };
  return { directory, mapping, seen, restore };
}

// ─── reading the directory ───

test('users are normalized to what matching needs, and junk rows are dropped', async () => {
  const { impl } = pagedFetch([{
    result: [
      bitrixRow(17, 'Alex', 'Smith', { EMAIL: 'a@x.io', WORK_POSITION: 'Recruiter', PERSONAL_MOBILE: '+15550001111' }),
      { ID: 'not-a-number', NAME: 'Ghost' },
      { NAME: 'No id at all' },
    ],
  }]);
  const { directory, restore } = loadModules();
  try {
    const res = await directory.fetchBitrixUsers({ fetchImpl: impl });
    assert.equal(res.ok, true);
    assert.equal(res.total, 1, 'rows without a usable id are not users');
    assert.deepEqual(res.users[0], {
      id: 17, firstName: 'Alex', lastName: 'Smith', fullName: 'Alex Smith',
      email: 'a@x.io', position: 'Recruiter', phones: ['+15550001111'], active: true,
    });
  } finally { restore(); }
});

test('all three phone fields are collected, since any of them may hold the number', async () => {
  const { impl } = pagedFetch([{
    result: [bitrixRow(17, 'Alex', 'Smith', {
      PERSONAL_MOBILE: '+15550001111', WORK_PHONE: '555-000-2222', PERSONAL_PHONE: null,
    })],
  }]);
  const { directory, restore } = loadModules();
  try {
    const res = await directory.fetchBitrixUsers({ fetchImpl: impl });
    assert.deepEqual(res.users[0].phones, ['+15550001111', '555-000-2222']);
  } finally { restore(); }
});

test('ACTIVE arrives as a boolean or as Y/N, and both are understood', async () => {
  const { impl } = pagedFetch([{
    result: [
      bitrixRow(1, 'A', 'One', { ACTIVE: false }),
      bitrixRow(2, 'B', 'Two', { ACTIVE: 'N' }),
      bitrixRow(3, 'C', 'Three', { ACTIVE: 'Y' }),
      bitrixRow(4, 'D', 'Four', { ACTIVE: true }),
    ],
  }]);
  const { directory, restore } = loadModules();
  try {
    const res = await directory.fetchBitrixUsers({ fetchImpl: impl });
    assert.deepEqual(res.users.map((u) => u.active), [false, false, true, true]);
  } finally { restore(); }
});

test('a nameless user still gets a label, so a picker never shows a blank row', async () => {
  const { impl } = pagedFetch([{ result: [{ ID: '42' }] }]);
  const { directory, restore } = loadModules();
  try {
    const res = await directory.fetchBitrixUsers({ fetchImpl: impl });
    assert.equal(res.users[0].fullName, 'Bitrix user 42');
  } finally { restore(); }
});

test('paging follows `next` until it stops advancing', async () => {
  const { impl, calls } = pagedFetch([
    { result: [bitrixRow(1, 'A', 'One')], next: 50 },
    { result: [bitrixRow(2, 'B', 'Two')], next: 100 },
    { result: [bitrixRow(3, 'C', 'Three')] },
  ]);
  const { directory, restore } = loadModules();
  try {
    const res = await directory.fetchBitrixUsers({ fetchImpl: impl });
    assert.equal(res.total, 3);
    assert.deepEqual(calls.map((u) => new URL(u).searchParams.get('start')), ['0', '50', '100']);
  } finally { restore(); }
});

test('a `next` that does not advance stops the loop instead of spinning', async () => {
  const { impl, calls } = pagedFetch([
    { result: [bitrixRow(1, 'A', 'One')], next: 0 },
    { result: [bitrixRow(2, 'B', 'Two')] },
  ]);
  const { directory, restore } = loadModules();
  try {
    const res = await directory.fetchBitrixUsers({ fetchImpl: impl });
    assert.equal(res.total, 1);
    assert.equal(calls.length, 1);
  } finally { restore(); }
});

test('a webhook without the user scope is named as exactly that', async () => {
  const { impl } = pagedFetch([{ error: 'ACCESS_DENIED', error_description: 'Access denied' }]);
  const { directory, mapping, restore } = loadModules();
  try {
    const res = await directory.fetchBitrixUsers({ fetchImpl: impl });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'no_user_scope');
    assert.match(mapping.FAILURE_MESSAGES.no_user_scope, /"user" scope/);
    assert.match(mapping.FAILURE_MESSAGES.no_user_scope, /by hand/, 'it must say what to do instead');
  } finally { restore(); }
});

test('another REST error is reported as itself, not as a scope problem', async () => {
  const { impl } = pagedFetch([{ error: 'QUERY_LIMIT_EXCEEDED', error_description: 'Too many requests' }]);
  const { directory, restore } = loadModules();
  try {
    const res = await directory.fetchBitrixUsers({ fetchImpl: impl });
    assert.equal(res.reason, 'rest_error');
    assert.equal(res.detail, 'Too many requests');
  } finally { restore(); }
});

test('a network failure is returned, never thrown', async () => {
  const { directory, restore } = loadModules();
  try {
    const res = await directory.fetchBitrixUsers({
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'request_failed');
    assert.equal(res.detail, 'ECONNREFUSED');
  } finally { restore(); }
});

test('an HTTP error with no REST body is still a reported failure', async () => {
  const { impl } = pagedFetch([{ __http: false, __status: 503 }]);
  const { directory, restore } = loadModules();
  try {
    const res = await directory.fetchBitrixUsers({ fetchImpl: impl });
    assert.equal(res.reason, 'request_failed');
    assert.equal(res.detail, 'HTTP 503');
  } finally { restore(); }
});

test('Bitrix not configured is a reason, not an attempted request', async () => {
  const { directory, restore } = loadModules({ enabled: false });
  try {
    const res = await directory.fetchBitrixUsers({
      fetchImpl: async () => { throw new Error('must not be called'); },
    });
    assert.equal(res.reason, 'not_configured');
  } finally { restore(); }
});

test('only the host of the webhook is ever exposed', async () => {
  const { directory, restore } = loadModules();
  try {
    assert.equal(directory.webhookHost(), 'wenze.bitrix24.com');
  } finally { restore(); }
});

// ─── preview and apply ───

const ROWS = [
  { id: 1, name: 'Alex Smith', phone_number: '+15550001111', active: true, bitrixUserId: null },
  { id: 2, name: 'Dana', phone_number: '+15552223333', active: true, bitrixUserId: null },
  { id: 3, name: 'Chris Green', phone_number: '+15554445555', active: true, bitrixUserId: 77 },
];

const PORTAL = [{
  result: [
    bitrixRow(17, 'Alex', 'Smith', { PERSONAL_MOBILE: '+15550001111' }),
    bitrixRow(21, 'Dana', 'Vaughn'),
    bitrixRow(77, 'Chris', 'Green'),
  ],
}];

test('preview writes nothing, and separates strong matches from guesses', async () => {
  const { impl } = pagedFetch(PORTAL);
  const { mapping, seen, restore } = loadModules({ recruiters: ROWS });
  try {
    const plan = await mapping.previewRecruiterBitrixMapping({ fetchImpl: impl });
    assert.equal(plan.ok, true);
    assert.equal(plan.bitrixUsers, 3);
    assert.equal(plan.recruiters, 3);
    assert.deepEqual(plan.apply.map((e) => [e.recruiterId, e.bitrixUserId, e.via]), [[1, 17, 'phone']]);
    assert.deepEqual(plan.propose.map((e) => [e.recruiterId, e.bitrixUserId]), [[2, 21]]);
    assert.deepEqual(plan.alreadyMapped.map((e) => e.recruiterId), [3]);
    assert.equal(seen.updates.length, 0, 'preview must not write');
  } finally { restore(); }
});

test('apply writes the strong matches only', async () => {
  const { impl } = pagedFetch(PORTAL);
  const { mapping, seen, restore } = loadModules({ recruiters: ROWS });
  try {
    const result = await mapping.applyRecruiterBitrixMapping({ fetchImpl: impl });
    assert.deepEqual(seen.updates, [{ id: 1, payload: { bitrixUserId: 17 } }]);
    assert.deepEqual(result.applied.map((e) => e.recruiterId), [1]);
    assert.deepEqual(result.failed, []);
  } finally { restore(); }
});

test('a confirmed first-name proposal is written too', async () => {
  const { impl } = pagedFetch(PORTAL);
  const { mapping, seen, restore } = loadModules({ recruiters: ROWS });
  try {
    const result = await mapping.applyRecruiterBitrixMapping({ fetchImpl: impl, confirm: ['2'] });
    assert.deepEqual(seen.updates.map((u) => u.id).sort(), [1, 2]);
    assert.deepEqual(result.applied.map((e) => e.recruiterId).sort(), [1, 2]);
  } finally { restore(); }
});

test('a confirm list naming nobody in the plan changes nothing extra', async () => {
  const { impl } = pagedFetch(PORTAL);
  const { mapping, seen, restore } = loadModules({ recruiters: ROWS });
  try {
    await mapping.applyRecruiterBitrixMapping({ fetchImpl: impl, confirm: [999, 'junk', null] });
    assert.deepEqual(seen.updates.map((u) => u.id), [1]);
  } finally { restore(); }
});

test('one rejected row does not abandon the rest of the plan', async () => {
  // The partial unique index on bitrix_user_id is what would reject a row.
  const { impl } = pagedFetch([{
    result: [
      bitrixRow(17, 'Alex', 'Smith', { PERSONAL_MOBILE: '+15550001111' }),
      bitrixRow(21, 'Dana', 'Vaughn', { PERSONAL_MOBILE: '+15552223333' }),
    ],
  }]);
  const { mapping, restore } = loadModules({
    recruiters: ROWS.slice(0, 2),
    onUpdate: (id) => {
      if (id === 1) { const e = new Error('duplicate key value'); e.code = '23505'; throw e; }
      return { id };
    },
  });
  try {
    const result = await mapping.applyRecruiterBitrixMapping({ fetchImpl: impl });
    assert.deepEqual(result.applied.map((e) => e.recruiterId), [2], 'the second row still lands');
    assert.deepEqual(result.failed.map((e) => e.recruiterId), [1]);
    assert.match(result.failed[0].error, /duplicate key/);
  } finally { restore(); }
});

test('a recruiter deleted mid-apply is a failure, not a silent success', async () => {
  const { impl } = pagedFetch(PORTAL);
  const { mapping, restore } = loadModules({ recruiters: ROWS, onUpdate: () => null });
  try {
    const result = await mapping.applyRecruiterBitrixMapping({ fetchImpl: impl });
    assert.deepEqual(result.applied, []);
    assert.match(result.failed[0].error, /no longer exists/i);
  } finally { restore(); }
});

test('an unreadable directory reports the reason and writes nothing', async () => {
  const { impl } = pagedFetch([{ error: 'ACCESS_DENIED' }]);
  const { mapping, seen, restore } = loadModules({ recruiters: ROWS });
  try {
    const result = await mapping.applyRecruiterBitrixMapping({ fetchImpl: impl });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no_user_scope');
    assert.match(result.message, /user" scope/);
    assert.deepEqual(result.applied, []);
    assert.equal(seen.updates.length, 0);
  } finally { restore(); }
});

// ─── the endpoints ───

function loadApp({ directory, preview, apply } = {}) {
  const seen = { previews: 0, applies: [] };
  require.cache[MAP_PATH] = {
    exports: {
      FAILURE_MESSAGES: { no_user_scope: 'needs the "user" scope' },
      previewRecruiterBitrixMapping: async () => {
        seen.previews += 1;
        return preview || { ok: true, apply: [], propose: [], bitrixHost: 'wenze.bitrix24.com' };
      },
      applyRecruiterBitrixMapping: async (args) => {
        seen.applies.push(args);
        return apply || { ok: true, applied: [{ recruiterId: 1, bitrixUserId: 17 }], failed: [] };
      },
    },
  };
  require.cache[DIR_PATH] = {
    exports: {
      fetchBitrixUsers: async () => directory || { ok: true, users: [{ id: 17, fullName: 'Alex Smith' }], total: 1 },
      webhookHost: () => 'wenze.bitrix24.com',
    },
  };

  delete require.cache[ROUTE_PATH];
  const { registerRecruiterBitrixMappingRoutes } = require(ROUTE_PATH);
  const app = express();
  app.use(express.json());
  const router = express.Router();
  let authCalls = 0;
  registerRecruiterBitrixMappingRoutes(router, {
    authMiddleware: (req, _res, next) => { authCalls += 1; req.admin = { username: 'admin' }; next(); },
  });
  app.use('/api/recruiters', router);
  const restore = () => { for (const p of [MAP_PATH, DIR_PATH, ROUTE_PATH]) delete require.cache[p]; };
  return { app, seen, restore, authCalls: () => authCalls };
}

async function call(app, method, pathname, body) {
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, text, json: text ? JSON.parse(text) : null };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('both endpoints are admin-guarded', async () => {
  const { app, restore, authCalls } = loadApp();
  try {
    await call(app, 'GET', '/api/recruiters/bitrix-users');
    await call(app, 'POST', '/api/recruiters/bitrix-automap', {});
    assert.equal(authCalls(), 2);
  } finally { restore(); }
});

test('the directory endpoint returns users and the host, never the webhook path', async () => {
  const { app, restore } = loadApp();
  try {
    const res = await call(app, 'GET', '/api/recruiters/bitrix-users');
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.bitrixHost, 'wenze.bitrix24.com');
    assert.ok(!res.text.includes('super-secret-value'), 'the path IS the credential');
  } finally { restore(); }
});

test('a Bitrix phone number never reaches the browser — matching needs it, a picker does not', async () => {
  const { app, restore } = loadApp({
    directory: {
      ok: true,
      total: 1,
      users: [{
        id: 17, fullName: 'Alex Smith', email: 'a@x.io', position: 'Recruiter',
        active: true, firstName: 'Alex', lastName: 'Smith', phones: ['+15550001111'],
      }],
    },
  });
  try {
    const res = await call(app, 'GET', '/api/recruiters/bitrix-users');
    assert.ok(!res.text.includes('5550001111'), 'phones are matched server-side');
    assert.deepEqual(res.json.users, [{
      id: 17, fullName: 'Alex Smith', email: 'a@x.io', position: 'Recruiter', active: true,
    }]);
  } finally { restore(); }
});

test('an unreadable directory answers 200 with the reason, not a 500', async () => {
  const { app, restore } = loadApp({ directory: { ok: false, reason: 'no_user_scope', users: [] } });
  try {
    const res = await call(app, 'GET', '/api/recruiters/bitrix-users');
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, false);
    assert.match(res.json.message, /"user" scope/);
  } finally { restore(); }
});

test('automap previews unless apply is explicitly true', async () => {
  const { app, seen, restore } = loadApp();
  try {
    const previewed = await call(app, 'POST', '/api/recruiters/bitrix-automap', {});
    assert.equal(previewed.json.mode, 'preview');
    assert.equal(seen.applies.length, 0, 'a bare POST must never write');

    const truthy = await call(app, 'POST', '/api/recruiters/bitrix-automap', { apply: 'yes' });
    assert.equal(truthy.json.mode, 'preview', 'only a real boolean true writes');
    assert.equal(seen.applies.length, 0);
    assert.equal(seen.previews, 2);
  } finally { restore(); }
});

test('apply:true writes and passes the confirm list through', async () => {
  const { app, seen, restore } = loadApp();
  try {
    const res = await call(app, 'POST', '/api/recruiters/bitrix-automap', { apply: true, confirm: [2] });
    assert.equal(res.json.mode, 'apply');
    assert.deepEqual(res.json.applied, [{ recruiterId: 1, bitrixUserId: 17 }]);
    assert.deepEqual(seen.applies, [{ confirm: [2] }]);
  } finally { restore(); }
});

test('a preview response always carries applied/failed so the panel can render one shape', async () => {
  const { app, restore } = loadApp();
  try {
    const res = await call(app, 'POST', '/api/recruiters/bitrix-automap', {});
    assert.deepEqual(res.json.applied, []);
    assert.deepEqual(res.json.failed, []);
  } finally { restore(); }
});
