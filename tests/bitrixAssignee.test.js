/**
 * Reading back WHO Bitrix24 assigned a new lead to.
 *
 * This is the fact the whole per-recruiter SMS feature turns on, and it is not
 * available at creation time: `crm.lead.add` returns an id, then a distribution
 * rule assigns the record moments later. So the reader polls — and everything
 * worth testing here is about the polling being bounded, cheap when the answer
 * is already right, and silent about failures rather than throwing at a lead.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.MANAGEMENT_GROUP_ID ||= '-1001234567890';
process.env.JWT_SECRET ||= 'test-jwt-secret';
process.env.PORT ||= '3001';

const WEBHOOK = 'https://example.bitrix24.com/rest/1/secret/';

/** Load the service with Bitrix configured, isolated from ambient env. */
function loadBitrix({ enabled = 'true', url = WEBHOOK, entity = 'lead' } = {}) {
  const saved = {
    BITRIX24_ENABLED: process.env.BITRIX24_ENABLED,
    BITRIX24_WEBHOOK_URL: process.env.BITRIX24_WEBHOOK_URL,
    BITRIX24_ENTITY: process.env.BITRIX24_ENTITY,
  };
  process.env.BITRIX24_ENABLED = enabled;
  if (url) process.env.BITRIX24_WEBHOOK_URL = url; else delete process.env.BITRIX24_WEBHOOK_URL;
  process.env.BITRIX24_ENTITY = entity;
  delete require.cache[require.resolve('../config/config')];
  delete require.cache[require.resolve('../services/bitrix24Service')];
  const mod = require('../services/bitrix24Service');
  const restore = () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete require.cache[require.resolve('../config/config')];
    delete require.cache[require.resolve('../services/bitrix24Service')];
  };
  return { mod, restore };
}

/** A fetch stand-in that answers each call from a queue and records the URLs. */
function queuedFetch(responses) {
  const urls = [];
  let i = 0;
  const impl = async (url) => {
    urls.push(String(url));
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (typeof next === 'function') return next();
    return { ok: true, status: 200, json: async () => next };
  };
  return { impl, urls, calls: () => i };
}

test('getCrmRecordAssignee reads ASSIGNED_BY_ID from crm.lead.get', async () => {
  const { mod, restore } = loadBitrix();
  try {
    // Bitrix returns every field as a string — the number must survive that.
    const fetchImpl = queuedFetch([{ result: { ID: '42', ASSIGNED_BY_ID: '17' } }]);
    const result = await mod.getCrmRecordAssignee({ bitrixId: 42, fetchImpl: fetchImpl.impl });
    assert.deepEqual(result, { ok: true, assignedById: 17 });
    assert.equal(fetchImpl.urls[0], `${WEBHOOK}crm.lead.get.json?id=42`);
  } finally { restore(); }
});

test('a deal reads crm.deal.get, not crm.lead.get', async () => {
  const { mod, restore } = loadBitrix({ entity: 'deal' });
  try {
    const fetchImpl = queuedFetch([{ result: { ASSIGNED_BY_ID: '9' } }]);
    const result = await mod.getCrmRecordAssignee({ bitrixId: 7, fetchImpl: fetchImpl.impl });
    assert.equal(result.assignedById, 9);
    assert.match(fetchImpl.urls[0], /crm\.deal\.get\.json\?id=7$/);
  } finally { restore(); }
});

test('an unassigned record reports null rather than a bogus id', async () => {
  const { mod, restore } = loadBitrix();
  try {
    for (const raw of [undefined, null, '', '0', 'not-a-number']) {
      const fetchImpl = queuedFetch([{ result: { ASSIGNED_BY_ID: raw } }]);
      const result = await mod.getCrmRecordAssignee({ bitrixId: 1, fetchImpl: fetchImpl.impl });
      assert.equal(result.ok, true, `raw=${raw}`);
      assert.equal(result.assignedById, null, `raw=${raw}`);
    }
  } finally { restore(); }
});

test('a Bitrix error or a network failure is reported, never thrown', async () => {
  const { mod, restore } = loadBitrix();
  try {
    const errored = await mod.getCrmRecordAssignee({
      bitrixId: 1,
      fetchImpl: async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: 'NOT_FOUND', error_description: 'Lead not found' }),
      }),
    });
    assert.equal(errored.ok, false);
    assert.equal(errored.reason, 'api_error');
    assert.match(errored.error, /Lead not found/);

    const down = await mod.getCrmRecordAssignee({
      bitrixId: 1,
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    });
    assert.equal(down.ok, false);
    assert.equal(down.reason, 'network_error');
  } finally { restore(); }
});

test('an unconfigured Bitrix, or a junk id, is not a request at all', async () => {
  const off = loadBitrix({ enabled: 'false', url: '' });
  try {
    let called = false;
    const result = await off.mod.getCrmRecordAssignee({
      bitrixId: 5,
      fetchImpl: async () => { called = true; return { ok: true, json: async () => ({}) }; },
    });
    assert.equal(result.reason, 'not_configured');
    assert.equal(called, false);
  } finally { off.restore(); }

  const on = loadBitrix();
  try {
    for (const bad of [null, undefined, 0, -1, 'abc']) {
      const result = await on.mod.getCrmRecordAssignee({
        bitrixId: bad,
        fetchImpl: async () => { throw new Error('must not be called'); },
      });
      assert.equal(result.reason, 'invalid_id', `bitrixId=${bad}`);
    }
  } finally { on.restore(); }
});

test('an already-acceptable assignee costs ONE read and no delay', async () => {
  const { mod, restore } = loadBitrix();
  try {
    const fetchImpl = queuedFetch([{ result: { ASSIGNED_BY_ID: '17' } }]);
    let slept = 0;
    const outcome = await mod.waitForCrmAssignee({
      bitrixId: 1,
      attempts: 6,
      intervalMs: 5000,
      sleep: async (ms) => { slept += ms; },
      fetchImpl: fetchImpl.impl,
    });
    assert.deepEqual(
      { assignedById: outcome.assignedById, accepted: outcome.accepted, attempts: outcome.attempts },
      { assignedById: 17, accepted: true, attempts: 1 },
    );
    assert.equal(slept, 0, 'a lead that is already assigned must not wait');
    assert.equal(fetchImpl.calls(), 1);
  } finally { restore(); }
});

test('it keeps asking while the record is unassigned, and stops as soon as it is', async () => {
  const { mod, restore } = loadBitrix();
  try {
    // The real shape: created unassigned, then a distribution rule fires.
    const fetchImpl = queuedFetch([
      { result: { ASSIGNED_BY_ID: null } },
      { result: { ASSIGNED_BY_ID: null } },
      { result: { ASSIGNED_BY_ID: '17' } },
      { result: { ASSIGNED_BY_ID: '99' } },
    ]);
    const sleeps = [];
    const outcome = await mod.waitForCrmAssignee({
      bitrixId: 1,
      attempts: 6,
      intervalMs: 5000,
      sleep: async (ms) => { sleeps.push(ms); },
      fetchImpl: fetchImpl.impl,
    });
    assert.equal(outcome.assignedById, 17);
    assert.equal(outcome.accepted, true);
    assert.equal(outcome.attempts, 3);
    assert.deepEqual(sleeps, [5000, 5000], 'one wait between each retry, none before the first');
    assert.equal(fetchImpl.calls(), 3, 'it stops the moment the answer is usable');
  } finally { restore(); }
});

test('the caller decides what "usable" means', async () => {
  const { mod, restore } = loadBitrix();
  try {
    // An assignee the SMS sender cannot use (unmapped recruiter) keeps polling.
    const fetchImpl = queuedFetch([
      { result: { ASSIGNED_BY_ID: '3' } },
      { result: { ASSIGNED_BY_ID: '17' } },
    ]);
    const outcome = await mod.waitForCrmAssignee({
      bitrixId: 1,
      isAcceptable: (id) => id === 17,
      attempts: 4,
      intervalMs: 1,
      sleep: async () => {},
      fetchImpl: fetchImpl.impl,
    });
    assert.equal(outcome.assignedById, 17);
    assert.equal(outcome.attempts, 2);
  } finally { restore(); }
});

test('the budget is honoured, and the last answer is still reported', async () => {
  const { mod, restore } = loadBitrix();
  try {
    const fetchImpl = queuedFetch([{ result: { ASSIGNED_BY_ID: '3' } }]);
    const outcome = await mod.waitForCrmAssignee({
      bitrixId: 1,
      isAcceptable: () => false,
      attempts: 3,
      intervalMs: 1,
      sleep: async () => {},
      fetchImpl: fetchImpl.impl,
    });
    assert.equal(fetchImpl.calls(), 3, 'exactly the attempt budget, never more');
    assert.equal(outcome.accepted, false);
    assert.equal(outcome.reason, 'not_acceptable');
    // Who Bitrix DID name still comes back, so the caller can say why it fell back.
    assert.equal(outcome.assignedById, 3);
  } finally { restore(); }
});

test('a configuration problem gives up immediately instead of burning the budget', async () => {
  const { mod, restore } = loadBitrix({ enabled: 'false', url: '' });
  try {
    let calls = 0;
    const outcome = await mod.waitForCrmAssignee({
      bitrixId: 1,
      attempts: 6,
      intervalMs: 1,
      sleep: async () => { calls += 1; },
      fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
    });
    assert.equal(outcome.attempts, 1);
    assert.equal(outcome.reason, 'not_configured');
    assert.equal(calls, 0);
  } finally { restore(); }
});

test('the wait budget comes from BITRIX24_ASSIGNEE_WAIT_MS, and 0 means do not wait', async () => {
  const saved = process.env.BITRIX24_ASSIGNEE_WAIT_MS;
  try {
    process.env.BITRIX24_ASSIGNEE_WAIT_MS = '25000';
    let { mod, restore } = loadBitrix();
    assert.equal(mod.ASSIGNEE_POLL_INTERVAL_MS, 5000);
    assert.equal(mod.assigneeAttempts(), 6, '25s of budget at 5s a poll');
    restore();

    process.env.BITRIX24_ASSIGNEE_WAIT_MS = '0';
    ({ mod, restore } = loadBitrix());
    assert.equal(mod.assigneeAttempts(), 1, 'one read, then whatever Bitrix said');
    restore();
  } finally {
    if (saved === undefined) delete process.env.BITRIX24_ASSIGNEE_WAIT_MS;
    else process.env.BITRIX24_ASSIGNEE_WAIT_MS = saved;
    delete require.cache[require.resolve('../config/config')];
    delete require.cache[require.resolve('../services/bitrix24Service')];
  }
});
