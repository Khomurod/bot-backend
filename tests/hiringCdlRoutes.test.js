'use strict';

/**
 * The two settings surfaces of the CDL reading, over HTTP (owner, 14 November
 * 2026): Settings → AI → "Providers for one task" (a task's own providers,
 * checked against the providers that exist; a task that needs a choice cannot
 * be handed to the global order) and Settings → Safety Approvals → 6 (the
 * Bitrix fields, read on demand; the mapping, checked). The data layer and
 * Bitrix are stubbed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const ROOT = path.resolve(__dirname, '..');
function stub(rel, exports) {
  const filename = require.resolve(path.resolve(ROOT, rel));
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const saved = { orders: [], maps: [] };
let invalidated = 0;
let fieldAnswer = null;
stub('database/aiSettings.js', {
  listCapabilities: async () => [{ capabilityKey: 'hiring_cdl_reading', aiEnabled: true, providerOrder: ['gemini'] }],
  getAiSettings: async () => ({ freeOnlyMode: true }),
  setCapabilityProviderOrder: async (key, order, extra) => {
    saved.orders.push({ key, order, ...extra });
    return { capabilityKey: key, providerOrder: order };
  },
});
stub('database/aiProviders.js', {
  listProvidersForAdmin: async () => [
    { providerKey: 'gemini', label: 'Google Gemini', adapter: 'gemini', enabled: true, isFree: true, modelChain: ['gemini-2.5-flash'], apiKeySet: true },
    { providerKey: 'cerebras', label: 'Cerebras', adapter: 'openai_chat', enabled: true, isFree: true, modelChain: ['qwen-3-32b'], apiKeySet: true },
    { providerKey: 'anthropic', label: 'Anthropic Claude', adapter: 'anthropic', enabled: true, isFree: false, modelChain: ['claude-sonnet-5-5'], apiKeySet: false },
  ],
});
stub('services/ai/capabilityGate.js', { invalidateCapabilityCache: () => { invalidated += 1; } });
stub('database/hiringStages/cdlFieldMap.js', {
  getFieldMap: async () => [{ item: 'date_of_birth', entity: 'contact', fieldCode: 'BIRTHDATE', fieldLabel: 'Date of birth' }],
  saveFieldMap: async (mapping, extra) => { saved.maps.push({ mapping, ...extra }); return mapping; },
});
stub('database/hiringStages/cdlReads.js', {
  listRecentReads: async () => [{
    id: 1, status: 'written', providerKey: 'gemini', model: 'gemini-2.5-flash', itemsWritten: 9, itemsInComment: 3,
    nameFromCdl: false, dealId: 61, contactId: 41, writtenItems: ['license_number'], createdAt: '2026-11-14T10:00:00Z',
  }],
});
stub('services/hiringStages/cdlBitrix.js', {
  readFieldLists: async () => {
    if (fieldAnswer instanceof Error) throw fieldAnswer;
    return fieldAnswer;
  },
});

const { createAiCapabilityProvidersRouter } = require('../server/routes/settings/aiCapabilityProvidersRoutes');
const { createHiringCdlSettingsRouter } = require('../server/routes/settings/hiringCdlRoutes');

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  const deps = { authMiddleware: (req, res, next) => { req.admin = { id: 5, username: 'owner' }; next(); } };
  app.use('/s', createAiCapabilityProvidersRouter(deps));
  app.use('/s', createHiringCdlSettingsRouter(deps));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}/s`);
  } finally {
    server.close();
  }
}
const send = (url, method, body) => fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('GET: the tasks with a choice, their list, and the providers — whether each can read a picture, never a key', async () => {
  await withServer(async (base) => {
    const body = await (await fetch(`${base}/ai/capability-providers`)).json();
    assert.deepEqual(body.capabilities.map((c) => [c.key, c.providerChoice, c.needsVision, c.order]),
      [['hiring_cdl_reading', 'required', true, ['gemini']]]);
    assert.deepEqual(body.providers.map((p) => [p.providerKey, p.canSee, p.hasKey]),
      [['gemini', true, true], ['cerebras', false, true], ['anthropic', true, false]]);
    assert.equal(body.freeOnlyMode, true);
    assert.doesNotMatch(JSON.stringify(body), /apiKey/);
  });
});

test('PUT: a list is saved in its order and the gate re-reads; unknown providers and "no list" are refused', async () => {
  await withServer(async (base) => {
    const url = `${base}/ai/capabilities/hiring_cdl_reading/providers`;
    let res = await send(url, 'PUT', { order: ['anthropic', 'gemini', 'anthropic'] });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).order, ['anthropic', 'gemini']);
    assert.deepEqual(saved.orders.at(-1), {
      key: 'hiring_cdl_reading', order: ['anthropic', 'gemini'], label: 'Read a candidate\'s CDL photo', updatedBy: 'owner',
    });
    assert.equal(invalidated, 1);

    res = await send(url, 'PUT', { order: [] });
    assert.deepEqual((await res.json()).order, [], 'nobody: nothing is read');

    res = await send(url, 'PUT', { order: ['openai'] });
    assert.equal(res.status, 400);
    res = await send(url, 'PUT', { order: null });
    assert.equal(res.status, 400, 'a task that needs a choice cannot follow the global order');
    res = await send(`${base}/ai/capabilities/nope/providers`, 'PUT', { order: [] });
    assert.equal(res.status, 404);
    // An ordinary task may be handed back to the global order.
    res = await send(`${base}/ai/capabilities/translation/providers`, 'PUT', { order: null });
    assert.deepEqual([res.status, (await res.json()).order], [200, null]);
  });
});

test('the CDL mapping: read, the Bitrix fields on demand, and a save that is checked', async () => {
  await withServer(async (base) => {
    const body = await (await fetch(`${base}/hiring-cdl`)).json();
    assert.equal(body.items.length, 21);
    assert.equal(body.mapping[0].fieldCode, 'BIRTHDATE');
    assert.deepEqual(Object.keys(body.recent[0]).sort(),
      ['createdAt', 'dealId', 'id', 'itemsInComment', 'itemsWritten', 'model', 'nameFromCdl', 'providerKey', 'status']);

    fieldAnswer = {
      contact: { BIRTHDATE: { type: 'date', title: 'Date of birth' }, PHONE: { type: 'crm_multifield' } },
      deal: { UF_CRM_CDL: { type: 'string', formLabel: 'CDL number' } },
    };
    let fields = await (await fetch(`${base}/hiring-cdl/bitrix-fields`, { method: 'POST' })).json();
    assert.deepEqual(fields, {
      ok: true,
      contact: [{ code: 'BIRTHDATE', label: 'Date of birth', type: 'date', multiple: false }],
      deal: [{ code: 'UF_CRM_CDL', label: 'CDL number', type: 'string', multiple: false }],
    });
    fieldAnswer = Object.assign(new Error('Bitrix crm.deal.fields: Access denied https://acme.bitrix24.com/rest/1/s3cret/'), { name: 'BitrixError' });
    fields = await (await fetch(`${base}/hiring-cdl/bitrix-fields`, { method: 'POST' })).json();
    assert.equal(fields.ok, false);
    assert.doesNotMatch(fields.error, /s3cret/, 'the webhook never appears');

    let res = await send(`${base}/hiring-cdl`, 'PUT', { mapping: [{ item: 'license_number', entity: 'deal', fieldCode: 'UF_CRM_CDL', fieldLabel: 'CDL number' }] });
    assert.equal(res.status, 200);
    assert.equal(saved.maps.at(-1).updatedBy, 'owner');
    res = await send(`${base}/hiring-cdl`, 'PUT', { mapping: [{ item: 'license_number', entity: 'deal', fieldCode: 'STAGE_ID' }] });
    assert.equal(res.status, 400);
    assert.equal(saved.maps.length, 1, 'nothing saved');
  });
});
