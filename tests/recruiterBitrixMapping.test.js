/**
 * Turning the Bitrix user directory into recruiter mappings.
 *
 * `recruiters.bitrix_user_id` is the only link from a Bitrix lead assignment
 * back to a recruiter row, and therefore what decides whose RingCentral number
 * texts a driver. So the properties pinned here are mostly refusals: preview
 * writes nothing, an existing mapping is never overwritten, a confirmation
 * must name the Bitrix user that was actually shown, and one rejected row does
 * not abandon the rest of the plan.
 *
 * Reading `user.get` itself is covered in recruiterBitrixDirectory.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const {
  DIR_PATH, MAP_PATH, ROUTE_PATH,
  bitrixRow, pagedFetch, loadModules,
} = require('./helpers/bitrixMappingHarness');

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
    const result = await mapping.applyRecruiterBitrixMapping({
      fetchImpl: impl,
      confirm: [{ recruiterId: 2, bitrixUserId: 21 }],
    });
    assert.deepEqual(seen.updates.map((u) => u.id).sort(), [1, 2]);
    assert.deepEqual(result.applied.map((e) => e.recruiterId).sort(), [1, 2]);
    assert.deepEqual(result.failed, []);
  } finally { restore(); }
});

test('a confirmation must name the Bitrix user that was shown', async () => {
  // The operator confirmed a PERSON. Apply re-reads the directory, so a
  // recruiter id on its own would authorize whoever it resolves to next.
  const { impl } = pagedFetch(PORTAL);
  const { mapping, seen, restore } = loadModules({ recruiters: ROWS });
  try {
    const result = await mapping.applyRecruiterBitrixMapping({
      fetchImpl: impl,
      confirm: [{ recruiterId: 2, bitrixUserId: 999 }],
    });
    assert.deepEqual(seen.updates.map((u) => u.id), [1], 'the proposal is NOT written');
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0].error, /Confirmed Bitrix user 999, but the directory now matches 21/);
  } finally { restore(); }
});

test('a bare recruiter id is refused and said out loud, not silently ignored', async () => {
  const { impl } = pagedFetch(PORTAL);
  const { mapping, seen, restore } = loadModules({ recruiters: ROWS });
  try {
    const result = await mapping.applyRecruiterBitrixMapping({ fetchImpl: impl, confirm: [2] });
    assert.deepEqual(seen.updates.map((u) => u.id), [1]);
    assert.match(result.failed[0].error, /did not name a Bitrix user/);
  } finally { restore(); }
});

test('a confirmation for someone no longer proposed is reported', async () => {
  const { impl } = pagedFetch(PORTAL);
  const { mapping, seen, restore } = loadModules({ recruiters: ROWS });
  try {
    const result = await mapping.applyRecruiterBitrixMapping({
      fetchImpl: impl,
      confirm: [{ recruiterId: 999, bitrixUserId: 21 }],
    });
    assert.deepEqual(seen.updates.map((u) => u.id), [1]);
    assert.match(result.failed[0].error, /no longer proposed/);
  } finally { restore(); }
});

test('junk in the confirm list is skipped without disturbing the plan', async () => {
  const { impl } = pagedFetch(PORTAL);
  const { mapping, seen, restore } = loadModules({ recruiters: ROWS });
  try {
    const result = await mapping.applyRecruiterBitrixMapping({
      fetchImpl: impl,
      confirm: [null, 'junk', {}, { bitrixUserId: 21 }],
    });
    assert.deepEqual(seen.updates.map((u) => u.id), [1]);
    assert.deepEqual(result.failed, [], 'nothing identifiable was confirmed, so nothing failed');
  } finally { restore(); }
});

test('normalizeConfirmations keeps pairs and separates the id-only ones', async () => {
  const { mapping, restore } = loadModules();
  try {
    const { pairs, malformed } = mapping.normalizeConfirmations([
      { recruiterId: 2, bitrixUserId: 21 },
      { recruiterId: '3', bitrixUserId: '22' },
      5,
      { recruiterId: 7 },
      'nonsense',
    ]);
    assert.deepEqual(pairs, [{ recruiterId: 2, bitrixUserId: 21 }, { recruiterId: 3, bitrixUserId: 22 }]);
    assert.deepEqual(malformed, [5, 7]);
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

function loadApp({ directory, preview, apply, checkUser } = {}) {
  const seen = { previews: 0, applies: [], checks: [] };
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
      fetchBitrixUserById: async (id) => {
        seen.checks.push(id);
        if (checkUser) return checkUser(id);
        return {
          ok: true,
          user: { id: Number(id), fullName: 'Alex Smith', email: 'a@x.io', position: 'Recruiter', active: true },
        };
      },
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

test('the check endpoint confirms who an id belongs to, without the phone', async () => {
  const { app, seen, restore } = loadApp({
    checkUser: (id) => ({
      ok: true,
      user: { id: Number(id), fullName: 'Alex Smith', email: 'a@x.io', position: 'Recruiter', active: true, phones: ['+15550001111'] },
    }),
  });
  try {
    const res = await call(app, 'GET', '/api/recruiters/bitrix-users/17');
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.found, true);
    assert.equal(res.json.user.fullName, 'Alex Smith');
    assert.deepEqual(seen.checks, ['17']);
    assert.ok(!res.text.includes('5550001111'), 'a phone is never needed to confirm an id');
  } finally { restore(); }
});

test('a real request for a nonexistent id reports found:false, not an error', async () => {
  const { app, restore } = loadApp({ checkUser: () => ({ ok: true, user: null }) });
  try {
    const res = await call(app, 'GET', '/api/recruiters/bitrix-users/999');
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.found, false);
    assert.equal(res.json.user, null);
  } finally { restore(); }
});

test('a webhook without the user scope is named as the fixable thing it is', async () => {
  const { app, restore } = loadApp({ checkUser: () => ({ ok: false, reason: 'no_user_scope' }) });
  try {
    const res = await call(app, 'GET', '/api/recruiters/bitrix-users/17');
    assert.equal(res.json.ok, false);
    assert.equal(res.json.found, false);
    assert.match(res.json.message, /"user" scope/);
  } finally { restore(); }
});

test('a non-numeric id is refused with what to type', async () => {
  const { app, restore } = loadApp({ checkUser: () => ({ ok: false, reason: 'invalid_id' }) });
  try {
    const res = await call(app, 'GET', '/api/recruiters/bitrix-users/not-a-number');
    assert.equal(res.json.ok, false);
    assert.match(res.json.message, /numeric Bitrix user id/);
  } finally { restore(); }
});

test('the check endpoint is admin-guarded', async () => {
  const { app, restore, authCalls } = loadApp();
  try {
    await call(app, 'GET', '/api/recruiters/bitrix-users/17');
    assert.equal(authCalls(), 1);
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
