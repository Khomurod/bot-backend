'use strict';

/**
 * Only a lead with a name AND a phone number becomes a Bitrix record (owner,
 * 18 November 2026): lib/recruiting/crmLeadGate.js and its use in
 * services/bitrix24Service.js `createCrmRecordFromLead`. Names and numbers
 * are made up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.MANAGEMENT_GROUP_ID ||= '-1001234567890';
process.env.JWT_SECRET ||= 'test-jwt-secret';
process.env.PORT ||= '3001';

const { crmLeadReadiness } = require('../lib/recruiting/crmLeadGate');

test('a name and a callable number: ready', () => {
  assert.deepEqual(crmLeadReadiness({ firstName: 'Alice', lastName: 'Example', phone: '(470) 555-0134' }), { ok: true });
  assert.deepEqual(crmLeadReadiness({ firstName: 'Bo', phone: '+15550100777' }), { ok: true }, 'one name is a name');
  assert.deepEqual(crmLeadReadiness({ firstName: 'José', lastName: '', phone: '14705550134' }), { ok: true });
});

test('no name, or a "name" with no letters: not ready', () => {
  assert.deepEqual(crmLeadReadiness({ phone: '4705550134' }), { ok: false, missing: ['name'] });
  assert.deepEqual(crmLeadReadiness({ firstName: '.', lastName: '1', phone: '4705550134' }), { ok: false, missing: ['name'] });
  assert.deepEqual(crmLeadReadiness({ firstName: 'A', phone: '4705550134' }), { ok: false, missing: ['name'] }, 'one letter is not a name');
});

test('no phone, or a number nobody can call: not ready', () => {
  assert.deepEqual(crmLeadReadiness({ firstName: 'Alice', lastName: 'Example' }), { ok: false, missing: ['phone'] });
  assert.deepEqual(crmLeadReadiness({ firstName: 'Alice', phone: '555-0134' }), { ok: false, missing: ['phone'] }, 'seven digits');
  assert.deepEqual(crmLeadReadiness({ firstName: 'Alice', phone: 'call me' }), { ok: false, missing: ['phone'] });
  assert.deepEqual(crmLeadReadiness({}), { ok: false, missing: ['name', 'phone'] });
});

// The service: an incomplete lead never reaches Bitrix at all.
require.cache[require.resolve('../database/pool')] = {
  exports: { query: async () => ({ rows: [] }), pool: null, ping: async () => true },
};

function freshService() {
  process.env.BITRIX24_ENABLED = 'true';
  process.env.BITRIX24_WEBHOOK_URL = 'https://example.bitrix24.com/rest/1/secret';
  process.env.BITRIX24_ENTITY = 'lead';
  delete require.cache[require.resolve('../config/config')];
  delete require.cache[require.resolve('../services/bitrix24Service')];
  delete require.cache[require.resolve('../database/bitrix')];
  return require('../services/bitrix24Service');
}

test('createCrmRecordFromLead: a lead with no phone or no name asks Bitrix NOTHING', async (t) => {
  const saved = {
    enabled: process.env.BITRIX24_ENABLED, url: process.env.BITRIX24_WEBHOOK_URL, entity: process.env.BITRIX24_ENTITY,
  };
  t.after(() => {
    for (const [key, value] of [['BITRIX24_ENABLED', saved.enabled], ['BITRIX24_WEBHOOK_URL', saved.url], ['BITRIX24_ENTITY', saved.entity]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    delete require.cache[require.resolve('../config/config')];
    delete require.cache[require.resolve('../services/bitrix24Service')];
    delete require.cache[require.resolve('../database/bitrix')];
  });
  const { createCrmRecordFromLead } = freshService();
  const calls = [];
  const fetchImpl = async (url) => { calls.push(String(url)); return { ok: true, json: async () => ({ result: 1 }) }; };
  const base = { leadData: { id: '1' }, connection: { page_name: 'P', page_id: '1' }, fetchImpl };

  const noPhone = await createCrmRecordFromLead({ ...base, leadgenId: 'L1', fieldMap: { full_name: 'Alice Example' } });
  assert.equal(noPhone.ok, false);
  assert.equal(noPhone.reason, 'incomplete');
  assert.deepEqual(noPhone.missing, ['phone']);

  const noName = await createCrmRecordFromLead({ ...base, leadgenId: 'L2', fieldMap: { 'Phone Number': '+1 (470) 555-0134' } });
  assert.deepEqual(noName.missing, ['name']);
  assert.equal(calls.length, 0, 'nothing was sent to Bitrix, not even a read');
});
