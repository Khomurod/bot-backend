const test = require('node:test');
const assert = require('node:assert/strict');

process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.MANAGEMENT_GROUP_ID ||= '-1001234567890';
process.env.JWT_SECRET ||= 'test-jwt-secret';
process.env.PORT ||= '3001';

test('createCrmRecordFromLead returns not_configured when Bitrix is disabled', async () => {
  const originalEnabled = process.env.BITRIX24_ENABLED;
  const originalUrl = process.env.BITRIX24_WEBHOOK_URL;
  process.env.BITRIX24_ENABLED = 'false';
  delete process.env.BITRIX24_WEBHOOK_URL;

  delete require.cache[require.resolve('../config/config')];
  delete require.cache[require.resolve('../services/bitrix24Service')];
  const { createCrmRecordFromLead } = require('../services/bitrix24Service');

  const result = await createCrmRecordFromLead({
    fieldMap: { full_name: 'Test User' },
    leadData: { id: '1' },
    connection: { page_name: 'Test Page' },
    leadgenId: 'lg-1',
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_configured');

  if (originalEnabled !== undefined) process.env.BITRIX24_ENABLED = originalEnabled;
  else delete process.env.BITRIX24_ENABLED;
  if (originalUrl !== undefined) process.env.BITRIX24_WEBHOOK_URL = originalUrl;
  delete require.cache[require.resolve('../config/config')];
  delete require.cache[require.resolve('../services/bitrix24Service')];
});

test('createCrmRecordFromLead posts to crm.lead.add when configured', async () => {
  const originalEnabled = process.env.BITRIX24_ENABLED;
  const originalUrl = process.env.BITRIX24_WEBHOOK_URL;
  const originalEntity = process.env.BITRIX24_ENTITY;

  process.env.BITRIX24_ENABLED = 'true';
  process.env.BITRIX24_WEBHOOK_URL = 'https://example.bitrix24.com/rest/1/secret';
  process.env.BITRIX24_ENTITY = 'lead';

  delete require.cache[require.resolve('../config/config')];
  delete require.cache[require.resolve('../services/bitrix24Service')];
  const { createCrmRecordFromLead } = require('../services/bitrix24Service');

  let capturedUrl = '';
  let capturedBody = null;
  const mockFetch = async (url, options) => {
    capturedUrl = url;
    capturedBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ result: 99 }),
    };
  };

  const result = await createCrmRecordFromLead({
    fieldMap: { full_name: 'Alice Example', phone_number: '+15551234567' },
    leadData: { id: '12345' },
    connection: { page_name: 'WENZE Transport Services', page_id: '111' },
    leadgenId: 'leadgen-abc',
    formId: 'form-1',
    fetchImpl: mockFetch,
  });

  assert.equal(result.ok, true);
  assert.equal(result.bitrixId, 99);
  assert.equal(capturedUrl, 'https://example.bitrix24.com/rest/1/secret/crm.lead.add.json');
  assert.equal(capturedBody.fields.TITLE, 'Facebook Lead – Alice Example');
  assert.match(capturedBody.fields.COMMENTS, /leadgen-abc/);

  if (originalEnabled !== undefined) process.env.BITRIX24_ENABLED = originalEnabled;
  else delete process.env.BITRIX24_ENABLED;
  if (originalUrl !== undefined) process.env.BITRIX24_WEBHOOK_URL = originalUrl;
  else delete process.env.BITRIX24_WEBHOOK_URL;
  if (originalEntity !== undefined) process.env.BITRIX24_ENTITY = originalEntity;
  else delete process.env.BITRIX24_ENTITY;
  delete require.cache[require.resolve('../config/config')];
  delete require.cache[require.resolve('../services/bitrix24Service')];
});
