'use strict';

/**
 * services/bitrix24DealStages.js and services/hiringStages/dealFinder.js
 * against a fake Bitrix — no network, no webhook. Pinned: what each call
 * asks Bitrix, that a failure is a BitrixError a caller can act on, and that a
 * deal is found by phone first, by a WHOLE name second, and never when two
 * different people match. Names and numbers are made up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
function stub(rel, exports) {
  const filename = require.resolve(path.resolve(ROOT, rel));
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

let config = { enabled: true, webhookUrl: 'https://acme.bitrix24.com/rest/1/secret/' };
stub('database/bitrix.js', { getBitrixConfig: async () => config });

const bitrix = require('../services/bitrix24DealStages');
const { findCandidateDeal } = require('../services/hiringStages/dealFinder');

/** A fake Bitrix: `routes[method](params)` answers; every call is recorded. */
function fakeBitrix(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const method = String(url).replace('https://acme.bitrix24.com/rest/1/secret/', '').replace(/\.json$/, '');
    const params = JSON.parse(init.body);
    calls.push({ method, params });
    const handler = routes[method];
    const out = handler ? handler(params) : { error: 'ERROR_METHOD_NOT_FOUND' };
    return new Response(JSON.stringify(out.error ? out : { result: out }), { status: out.status || 200 });
  };
  return { calls, opts: { fetchImpl } };
}

const deal = (id, over = {}) => ({
  ID: String(id), TITLE: `Deal ${id}`, STAGE_ID: 'PREPARATION', CATEGORY_ID: '0',
  CONTACT_ID: '55', CLOSED: 'N', DATE_MODIFY: '2026-10-19T10:00:00+00:00', ...over,
});

test('the stage change is one crm.deal.update with only STAGE_ID', async () => {
  const { calls, opts } = fakeBitrix({ 'crm.deal.update': () => true });
  await bitrix.moveDealToStage(12, 'EXECUTING', opts);
  assert.deepEqual(calls, [{
    method: 'crm.deal.update',
    params: { id: 12, fields: { STAGE_ID: 'EXECUTING' }, params: { REGISTER_SONET_EVENT: 'Y' } },
  }]);
});

test('a pipeline\'s stages are asked by its own ENTITY_ID', async () => {
  const { calls, opts } = fakeBitrix({ 'crm.status.list': () => [] });
  await bitrix.listStageRows('0', opts);
  await bitrix.listStageRows('3', opts);
  assert.deepEqual(calls.map((c) => c.params.filter.ENTITY_ID), ['DEAL_STAGE', 'DEAL_STAGE_3']);
});

test('a Bitrix refusal, a 5xx and a hang are BitrixErrors — only the last two retryable', async () => {
  const refused = fakeBitrix({ 'crm.deal.get': () => ({ error: 'ACCESS_DENIED', error_description: 'no crm scope' }) });
  await assert.rejects(bitrix.getDeal(1, refused.opts), (e) => e instanceof bitrix.BitrixError && !e.retryable && /no crm scope/.test(e.message));

  const down = fakeBitrix({ 'crm.deal.get': () => ({ error: 'INTERNAL', status: 503 }) });
  await assert.rejects(bitrix.getDeal(1, down.opts), (e) => e.retryable === true);

  // AbortSignal.timeout's timer does not hold the process open; this one does.
  const hang = (_url, init) => new Promise((_r, reject) => {
    const keepAlive = setTimeout(() => {}, 5000);
    init.signal.addEventListener('abort', () => {
      clearTimeout(keepAlive);
      reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
    });
  });
  await assert.rejects(bitrix.getDeal(1, { fetchImpl: hang, timeoutMs: 20 }), (e) => e.retryable && /did not answer/.test(e.message));
});

test('no webhook, or Bitrix switched off, is said plainly and asks nothing', async () => {
  const saved = config;
  config = { enabled: false, webhookUrl: saved.webhookUrl };
  const { calls, opts } = fakeBitrix({});
  await assert.rejects(bitrix.getDeal(1, opts), (e) => e.reason === 'not_configured');
  assert.equal(calls.length, 0);
  config = saved;
  assert.equal(await bitrix.dealUrl(12), 'https://acme.bitrix24.com/crm/deal/details/12/');
});

test('BY PHONE: the contact holding the number, its newest open deal', async () => {
  const { calls, opts } = fakeBitrix({
    'crm.duplicate.findbycomm': () => ({ CONTACT: [55] }),
    'crm.deal.list': () => [deal(12, { DATE_MODIFY: '2026-10-18T10:00:00+00:00' }), deal(14)],
  });
  const out = await findCandidateDeal({ phones: ['4045550134'] }, opts);
  assert.equal(out.status, 'found');
  assert.equal(out.via, 'phone');
  assert.equal(out.deal.id, 14);
  assert.deepEqual(calls[0].params, { type: 'PHONE', values: ['+14045550134', '4045550134'], entity_type: 'CONTACT' });
  assert.deepEqual(calls[1].params.filter, { CONTACT_ID: 55, CLOSED: 'N' });
});

test('BY NAME: first AND last name must both be among the posted words, in any order', async () => {
  const { opts } = fakeBitrix({
    'crm.contact.list': () => [
      { ID: '55', NAME: 'Samuel', LAST_NAME: 'Phillips' },
      { ID: '56', NAME: 'Anna', LAST_NAME: 'Phillips' },
    ],
    'crm.deal.list': (p) => (p.filter.CONTACT_ID === 55 ? [deal(12)] : []),
  });
  const out = await findCandidateDeal({ phones: [], name: 'PHILLIPS SAMUEL JAHBARI' }, opts);
  assert.equal(out.status, 'found');
  assert.equal(out.via, 'name');
  assert.equal(out.deal.id, 12);
});

test('TWO DIFFERENT PEOPLE MATCHING IS AMBIGUOUS — nothing is picked', async () => {
  const { opts } = fakeBitrix({
    'crm.contact.list': () => [{ ID: '55', NAME: 'Sam', LAST_NAME: 'Lee' }, { ID: '57', NAME: 'Sam', LAST_NAME: 'Lee' }],
    'crm.deal.list': (p) => (p.filter.CONTACT_ID ? [deal(p.filter.CONTACT_ID * 10, { CONTACT_ID: String(p.filter.CONTACT_ID) })] : []),
  });
  assert.deepEqual(await findCandidateDeal({ name: 'Sam Lee' }, opts), { status: 'ambiguous', count: 2 });
});

test('a deal title is a match only with two of the posted words in it', async () => {
  const { opts } = fakeBitrix({
    'crm.contact.list': () => [],
    'crm.deal.list': () => [
      deal(30, { TITLE: 'Facebook Lead – Eldy Sebua', CONTACT_ID: null }),
      deal(31, { TITLE: 'Facebook Lead – Eldy Mart', CONTACT_ID: null }),
    ],
  });
  const out = await findCandidateDeal({ name: 'Eldy Sebua' }, opts);
  assert.equal(out.status, 'found');
  assert.equal(out.deal.id, 30);
  assert.deepEqual(await findCandidateDeal({ name: 'Sebua' }, opts), { status: 'none' }, 'one word is not a name');
});

test('nothing found by phone or name is "none"', async () => {
  const { opts } = fakeBitrix({
    'crm.duplicate.findbycomm': () => [],
    'crm.contact.list': () => [],
    'crm.deal.list': () => [],
  });
  assert.deepEqual(await findCandidateDeal({ phones: ['4045550134'], name: 'Joe Hardeman' }, opts), { status: 'none' });
});
