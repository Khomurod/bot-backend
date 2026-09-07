/**
 * database/bitrix.js — Bitrix24 settings, entered in the app.
 *
 * The rule under test is precedence: a value saved in the panel wins, a value
 * never saved (NULL) inherits the BITRIX24_* environment variable, and — the
 * case that motivated all of this — an EMPTY assignee saved in the panel beats
 * a NAME set in the environment, because that name is what Bitrix has been
 * silently ignoring in production.
 *
 * Also non-negotiable: the webhook URL is the credential. It is encrypted at
 * rest and the admin view exposes only its host — not a masked tail, since
 * the tail is part of the token.
 *
 * No database: `database/pool` is a fake that records SQL and hands back the
 * row a test chose.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.MANAGEMENT_GROUP_ID ||= '-1001234567890';
process.env.JWT_SECRET ||= 'test-jwt-secret';
process.env.PORT ||= '3001';

const POOL_PATH = require.resolve('../database/pool');
const CONFIG_PATH = require.resolve('../config/config');
const MODULE_PATH = require.resolve('../database/bitrix');

const ENV = {
  bitrix24Enabled: true,
  bitrix24WebhookUrl: 'https://env.bitrix24.com/rest/1/env-secret-token/',
  bitrix24Entity: 'lead',
  bitrix24AssignedById: 'Tom Robinson',
  bitrix24SourceId: 'WEB',
  bitrix24SourceDescription: 'Facebook / bot-backend',
  bitrix24AssigneeWaitMs: 25000,
  bitrix24DealCategoryId: '',
  bitrix24DealStageId: '',
};

/** Load the module against a fake pool that serves `row` and records writes. */
function load({ row = null, env = ENV, queryError = null } = {}) {
  const seen = { sql: [], params: [] };
  let stored = row;
  require.cache[POOL_PATH] = {
    exports: {
      pool: null,
      ping: async () => true,
      query: async (sql, params = []) => {
        seen.sql.push(sql);
        seen.params.push(params);
        if (queryError) throw queryError;
        if (/^SELECT/.test(sql)) return { rows: stored ? [stored] : [] };
        if (/^UPDATE/.test(sql)) {
          // Reflect the write so a following read sees it, like the real table.
          const sets = sql.match(/SET (.*) WHERE/)[1].split(', ');
          stored = { ...(stored || { id: 1 }) };
          let i = 0;
          for (const clause of sets) {
            const [column, rhs] = clause.split(' = ');
            if (rhs === 'NULL') stored[column] = null;
            else if (rhs === 'NOW()') stored[column] = new Date('2026-09-07T12:00:00Z');
            else stored[column] = params[i++];
          }
        }
        return { rows: [] };
      },
    },
  };
  const realConfig = require(CONFIG_PATH);
  require.cache[CONFIG_PATH] = { exports: { ...realConfig, ...env } };
  delete require.cache[MODULE_PATH];
  const mod = require(MODULE_PATH);
  const restore = () => {
    for (const p of [POOL_PATH, CONFIG_PATH, MODULE_PATH]) delete require.cache[p];
  };
  return { mod, seen, restore, stored: () => stored };
}

const { encryptText } = require('../lib/security/facebookCrypto');

// ─── precedence ───

test('with no row saved, every value comes from the environment', async () => {
  const { mod, restore } = load();
  try {
    const cfg = await mod.getBitrixConfig();
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.webhookUrl, ENV.bitrix24WebhookUrl);
    assert.equal(cfg.entity, 'lead');
    assert.equal(cfg.assignedById, 'Tom Robinson', 'the env value, wrong as it is, is what applies until someone saves');
    assert.equal(cfg.assigneeWaitMs, 25000);
    assert.deepEqual(cfg.fromEnv, { enabled: true, webhookUrl: true, entity: true, assignedById: true, assigneeWaitMs: true });
  } finally { restore(); }
});

test('a saved row wins over env for every column it fills', async () => {
  const { mod, restore } = load({
    row: {
      id: 1, enabled: false, webhook_url_encrypted: encryptText('https://app.bitrix24.com/rest/1/app-secret/'),
      entity: 'deal', assigned_by_id: '17', source_id: 'FB', source_description: 'desc',
      deal_category_id: '3', deal_stage_id: 'C3:NEW', assignee_wait_ms: 10000, updated_at: 'x',
    },
  });
  try {
    const cfg = await mod.getBitrixConfig();
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.webhookUrl, 'https://app.bitrix24.com/rest/1/app-secret/');
    assert.equal(cfg.entity, 'deal');
    assert.equal(cfg.assignedById, '17');
    assert.equal(cfg.sourceId, 'FB');
    assert.equal(cfg.dealCategoryId, '3');
    assert.equal(cfg.assigneeWaitMs, 10000);
    assert.deepEqual(cfg.fromEnv, { enabled: false, webhookUrl: false, entity: false, assignedById: false, assigneeWaitMs: false });
  } finally { restore(); }
});

test('a NULL column inherits env while a filled one beside it does not', async () => {
  const { mod, restore } = load({ row: { id: 1, enabled: null, webhook_url_encrypted: null, entity: 'deal', assigned_by_id: null } });
  try {
    const cfg = await mod.getBitrixConfig();
    assert.equal(cfg.enabled, true, 'inherited');
    assert.equal(cfg.webhookUrl, ENV.bitrix24WebhookUrl, 'inherited');
    assert.equal(cfg.entity, 'deal', 'saved');
    assert.equal(cfg.assignedById, 'Tom Robinson', 'inherited');
  } finally { restore(); }
});

test('an EMPTY assignee saved in the panel beats a NAME in the environment', async () => {
  // This is the whole point: "clear it" must win over "inherit it".
  const { mod, restore } = load({ row: { id: 1, assigned_by_id: '' } });
  try {
    const cfg = await mod.getBitrixConfig();
    assert.equal(cfg.assignedById, '');
    assert.equal(cfg.fromEnv.assignedById, false);
  } finally { restore(); }
});

test('a database that cannot be read degrades to env, and does not throw', async () => {
  const { mod, restore } = load({ queryError: new Error('ECONNREFUSED') });
  try {
    const cfg = await mod.getBitrixConfig();
    assert.equal(cfg.webhookUrl, ENV.bitrix24WebhookUrl);
  } finally { restore(); }
});

test('the config is cached briefly and a write invalidates it', async () => {
  const { mod, seen, restore } = load();
  try {
    await mod.getBitrixConfig();
    await mod.getBitrixConfig();
    assert.equal(seen.sql.filter((q) => /^SELECT/.test(q)).length, 1, 'second read served from cache');
    await mod.updateBitrixSettings({ enabled: false });
    const cfg = await mod.getBitrixConfig();
    assert.equal(cfg.enabled, false, 'the write is visible immediately');
  } finally { restore(); }
});

// ─── the secret ───

test('the webhook is encrypted at rest and never stored in the clear', async () => {
  const { mod, seen, stored, restore } = load();
  try {
    await mod.updateBitrixSettings({ webhookUrl: 'https://wenze.bitrix24.com/rest/1/live-secret-token/' });
    const update = seen.sql.find((q) => /^UPDATE/.test(q));
    const params = seen.params[seen.sql.indexOf(update)];
    assert.ok(!params.some((p) => String(p).includes('live-secret-token')), 'plaintext never reaches the database');
    assert.ok(!update.includes('live-secret-token'));
    assert.notEqual(stored().webhook_url_encrypted, 'https://wenze.bitrix24.com/rest/1/live-secret-token/');
    const cfg = await mod.getBitrixConfig();
    assert.equal(cfg.webhookUrl, 'https://wenze.bitrix24.com/rest/1/live-secret-token/', 'and decrypts back for the server');
  } finally { restore(); }
});

test('the admin view carries the host and never the URL — not even a masked tail', async () => {
  const { mod, restore } = load({
    row: { id: 1, webhook_url_encrypted: encryptText('https://wenze.bitrix24.com/rest/1/super-secret-value/') },
  });
  try {
    const view = await mod.getBitrixSettingsForAdmin();
    const text = JSON.stringify(view);
    assert.equal(view.webhookHost, 'wenze.bitrix24.com');
    assert.equal(view.webhookSet, true);
    assert.ok(!text.includes('super-secret-value'));
    assert.ok(!text.includes('alue'), 'no last-four either — it is part of the token');
    assert.equal(view.webhookUrl, undefined);
  } finally { restore(); }
});

test('clearWebhookUrl forgets the stored one and falls back to env', async () => {
  const { mod, stored, restore } = load({ row: { id: 1, webhook_url_encrypted: encryptText('https://x/rest/1/t/') } });
  try {
    await mod.updateBitrixSettings({ clearWebhookUrl: true });
    assert.equal(stored().webhook_url_encrypted, null);
    assert.equal((await mod.getBitrixConfig()).webhookUrl, ENV.bitrix24WebhookUrl);
  } finally { restore(); }
});

test('a webhook that is not a Bitrix REST URL is refused and nothing is written', async () => {
  const { mod, seen, restore } = load();
  try {
    await assert.rejects(
      () => mod.updateBitrixSettings({ webhookUrl: 'https://wenze.bitrix24.com/' }),
      (err) => err.statusCode === 400 && /rest\//.test(err.message),
    );
    assert.equal(seen.sql.filter((q) => /^UPDATE/.test(q)).length, 0);
  } finally { restore(); }
});

// ─── validation of what the operator types ───

test('a name as the assignee is refused with what to type instead', async () => {
  const { mod, seen, restore } = load();
  try {
    await assert.rejects(
      () => mod.updateBitrixSettings({ assignedById: 'Tom Robinson' }),
      (err) => err.statusCode === 400 && /not a Bitrix user id/.test(err.message),
    );
    assert.equal(seen.sql.filter((q) => /^UPDATE/.test(q)).length, 0, 'the row is untouched');
  } finally { restore(); }
});

test('the assignee accepts a number, a pasted profile URL, a #, or blank', async () => {
  const { mod, restore } = load();
  try {
    assert.equal(mod.normalizeAssignedById('17'), '17');
    assert.equal(mod.normalizeAssignedById('/company/personal/user/17/'), '17');
    assert.equal(mod.normalizeAssignedById('#17'), '17');
    assert.equal(mod.normalizeAssignedById(''), '');
    assert.equal(mod.normalizeAssignedById(null), '');
    assert.throws(() => mod.normalizeAssignedById('0'));
    assert.throws(() => mod.normalizeAssignedById('abc'));
  } finally { restore(); }
});

test('entity must be lead or deal', async () => {
  const { mod, restore } = load();
  try {
    await assert.rejects(() => mod.updateBitrixSettings({ entity: 'contact' }), (e) => e.statusCode === 400);
    await mod.updateBitrixSettings({ entity: 'DEAL' });
    assert.equal((await mod.getBitrixConfig()).entity, 'deal');
  } finally { restore(); }
});

test('the assignee wait is clamped, and a negative one is refused', async () => {
  const { mod, restore } = load();
  try {
    await mod.updateBitrixSettings({ assigneeWaitMs: 99999999 });
    assert.equal((await mod.getBitrixConfig()).assigneeWaitMs, mod.MAX_ASSIGNEE_WAIT_MS);
    await assert.rejects(() => mod.updateBitrixSettings({ assigneeWaitMs: -1 }), (e) => e.statusCode === 400);
  } finally { restore(); }
});

test('a save with nothing to change still invalidates the cache and returns the view', async () => {
  const { mod, seen, restore } = load();
  try {
    const view = await mod.updateBitrixSettings({});
    assert.equal(seen.sql.filter((q) => /^UPDATE/.test(q)).length, 0);
    assert.equal(view.webhookHost, 'env.bitrix24.com');
  } finally { restore(); }
});

test('a save re-seeds the single row before updating it, so a hand-deleted row cannot break the panel', async () => {
  const { mod, seen, restore } = load();
  try {
    await mod.updateBitrixSettings({ enabled: true });
    const insert = seen.sql.find((q) => /^INSERT INTO bitrix_settings/.test(q));
    assert.match(insert, /ON CONFLICT \(id\) DO NOTHING/);
  } finally { restore(); }
});
