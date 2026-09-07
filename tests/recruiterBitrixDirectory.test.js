/**
 * Reading the Bitrix24 user directory.
 *
 * `user.get` is the one Bitrix call this feature adds, and the failure an
 * operator will actually hit is a webhook created for `crm` alone — it answers
 * ACCESS_DENIED, which has to be reported as "add the `user` scope" rather
 * than as a bare REST error. Also covered: the shapes Bitrix really sends
 * (ACTIVE as a boolean or as Y/N, phones spread across three fields, rows with
 * no usable id) and that paging stops rather than spins.
 *
 * THE WEBHOOK URL IS THE CREDENTIAL: a Bitrix inbound webhook authenticates by
 * its path, so only its host may ever leave the server.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { bitrixRow, pagedFetch, loadModules } = require('./helpers/bitrixMappingHarness');

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
    assert.equal(await directory.webhookHost(), 'wenze.bitrix24.com');
  } finally { restore(); }
});

// ─── checking one id: is this a real person? ───

test('a known id returns exactly that person', async () => {
  const { impl, calls } = pagedFetch([{
    result: [bitrixRow(17, 'Alex', 'Smith', { WORK_POSITION: 'Recruiter', PERSONAL_MOBILE: '+15550001111' })],
  }]);
  const { directory, restore } = loadModules();
  try {
    const res = await directory.fetchBitrixUserById('17', { fetchImpl: impl });
    assert.equal(res.ok, true);
    assert.equal(res.user.id, 17);
    assert.equal(res.user.fullName, 'Alex Smith');
    assert.equal(res.user.position, 'Recruiter');
    assert.match(calls[0], /user\.get\.json\?ID=17/, 'it asks Bitrix for just that id');
  } finally { restore(); }
});

test('an id nobody has is ok:true with a null user, not an error', async () => {
  const { impl } = pagedFetch([{ result: [] }]);
  const { directory, restore } = loadModules();
  try {
    const res = await directory.fetchBitrixUserById('999', { fetchImpl: impl });
    assert.equal(res.ok, true);
    assert.equal(res.user, null);
    assert.equal(res.reason, 'not_found');
  } finally { restore(); }
});

test('a non-numeric id never reaches Bitrix', async () => {
  const { directory, restore } = loadModules();
  try {
    for (const bad of ['abc', '', '0', '-3', null]) {
      const res = await directory.fetchBitrixUserById(bad, {
        fetchImpl: async () => { throw new Error('must not be called'); },
      });
      assert.equal(res.ok, false);
      assert.equal(res.reason, 'invalid_id');
    }
  } finally { restore(); }
});

test('a webhook without the user scope is reported as exactly that', async () => {
  const { impl } = pagedFetch([{ error: 'ACCESS_DENIED', error_description: 'Access denied' }]);
  const { directory, restore } = loadModules();
  try {
    const res = await directory.fetchBitrixUserById('17', { fetchImpl: impl });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'no_user_scope');
  } finally { restore(); }
});

test('another REST error is reported as itself', async () => {
  const { impl } = pagedFetch([{ error: 'QUERY_LIMIT_EXCEEDED', error_description: 'Too many requests' }]);
  const { directory, restore } = loadModules();
  try {
    const res = await directory.fetchBitrixUserById('17', { fetchImpl: impl });
    assert.equal(res.reason, 'rest_error');
    assert.equal(res.detail, 'Too many requests');
  } finally { restore(); }
});

test('a network failure while checking is returned, never thrown', async () => {
  const { directory, restore } = loadModules();
  try {
    const res = await directory.fetchBitrixUserById('17', {
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'request_failed');
    assert.equal(res.detail, 'ECONNREFUSED');
  } finally { restore(); }
});

test('Bitrix not configured is a reason, not an attempted check', async () => {
  const { directory, restore } = loadModules({ enabled: false });
  try {
    const res = await directory.fetchBitrixUserById('17', {
      fetchImpl: async () => { throw new Error('must not be called'); },
    });
    assert.equal(res.reason, 'not_configured');
  } finally { restore(); }
});
