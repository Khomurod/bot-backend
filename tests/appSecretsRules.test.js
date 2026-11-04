'use strict';

/**
 * lib/appSecrets/rules.js — what may be stored, who reads it, what an upload
 * changes, and what must stop a save (docs/architecture/app-secrets.md).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../lib/appSecrets/rules');

const names = (list) => list.map((c) => `${c.scope}:${c.name}`);
const T = (n) => `${n}:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;

test('the bot app\'s required names are config/config.js\'s own list, less what stays in Coolify', () => {
  const { requiredEnv } = require('../config/config');
  const storable = requiredEnv.filter((n) => !rules.HOST_ONLY.includes(n));
  assert.deepEqual([...rules.REQUIRED.bot].sort(), storable.sort());
});

test('what stays in Coolify, what the platform sets, what a service does not need', () => {
  for (const n of ['DATABASE_URL', 'INTEGRATION_SECRET_KEY', 'PORT', 'APP_SECRETS_VERSION', 'APP_SECRETS_OFF']) {
    assert.equal(rules.skipReason(n, 'bot'), 'stays in Coolify');
  }
  assert.equal(rules.skipReason('COOLIFY_FQDN', 'bot'), 'set by the platform');
  assert.match(rules.skipReason('TELEGRAM_BOT_TOKEN', 'samsara'), /not needed/);
  assert.equal(rules.skipReason('TELEGRAM_BOT_TOKEN', 'bot'), null);
});

test('shared names land in "both"; a name with two meanings never does', () => {
  assert.equal(rules.scopeFor('BOT_TOKEN', 'samsara'), 'both');
  assert.equal(rules.scopeFor('GROQ_API_KEY', 'bot'), 'both');
  assert.equal(rules.scopeFor('GEMINI_TEXT_MODELS', 'samsara'), 'both');
  for (const n of ['TELEGRAM_BOT_TOKEN', 'USE_WEBHOOK', 'PUBLIC_WEBHOOK_URL', 'RENDER_EXTERNAL_URL']) {
    assert.equal(rules.scopeFor(n, 'bot'), 'bot');
    assert.equal(rules.scopeFor(n, 'samsara'), 'samsara');
  }
});

test('last four characters only for long values', () => {
  assert.equal(rules.last4('short'), '');
  assert.equal(rules.last4('123456789012'), '9012');
});

test('an upload replaces its own scope, only adds to "both", and leaves the other app alone', () => {
  const current = [
    { scope: 'both', name: 'BOT_TOKEN', value: 'old' },
    { scope: 'both', name: 'GROQ_API_KEY', value: 'g' },
    { scope: 'bot', name: 'JWT_SECRET', value: 'j' },
    { scope: 'bot', name: 'GONE', value: 'x' },
    { scope: 'samsara', name: 'SAMSARA_BOT_TOKEN', value: 's' },
  ];
  const plan = rules.planUpload({
    target: 'bot',
    current,
    entries: [
      { name: 'BOT_TOKEN', value: 'new' },
      { name: 'JWT_SECRET', value: 'j' },
      { name: 'NEW_ONE', value: 'n' },
      { name: 'DATABASE_URL', value: 'postgres://x' },
      { name: 'EMPTY', value: '' },
    ],
  });
  assert.deepEqual(names(plan.added), ['bot:NEW_ONE']);
  assert.deepEqual(names(plan.changed), ['both:BOT_TOKEN']);
  // GROQ_API_KEY (both) survives a file without it; GONE (bot) does not.
  assert.deepEqual(names(plan.removed), ['bot:GONE']);
  assert.equal(plan.unchanged, 3); // GROQ_API_KEY, JWT_SECRET, SAMSARA_BOT_TOKEN
  assert.deepEqual(plan.skipped.map((s) => s.name), ['DATABASE_URL', 'EMPTY']);
  assert.ok(plan.items.some((i) => i.scope === 'samsara' && i.name === 'SAMSARA_BOT_TOKEN' && i.value === 's'));
  assert.throws(() => rules.planUpload({ target: 'x', current: [], entries: [] }), /Unknown target/);
});

test('a save is blocked when this app could not start, or two bots share a token', () => {
  const host = { JWT_SECRET: 'j', FACEBOOK_TOKEN_ENCRYPTION_KEY: 'f' };
  const ok = rules.checkVersion({
    hostEnv: host,
    items: [
      { scope: 'both', name: 'BOT_TOKEN', value: T(1) },
      { scope: 'bot', name: 'TELEGRAM_BOT_TOKEN', value: T(2) },
    ],
  });
  assert.deepEqual(ok.blocking, []);

  const missing = rules.checkVersion({ hostEnv: {}, items: [{ scope: 'both', name: 'BOT_TOKEN', value: T(1) }] });
  assert.ok(missing.blocking.some((b) => b.startsWith('JWT_SECRET is missing')));
  assert.ok(missing.blocking.some((b) => b.startsWith('TELEGRAM_BOT_TOKEN is missing')));

  const same = rules.checkVersion({
    hostEnv: host,
    items: [
      { scope: 'both', name: 'BOT_TOKEN', value: T(1) },
      { scope: 'bot', name: 'TELEGRAM_BOT_TOKEN', value: T(2) },
      { scope: 'samsara', name: 'SAMSARA_BOT_TOKEN', value: T(1) },
    ],
  });
  assert.deepEqual(same.blocking, ['BOT_TOKEN and SAMSARA_BOT_TOKEN are the same token — each bot needs its own']);
  assert.ok(!JSON.stringify(same).includes(T(1)), 'no value in a problem');
});

test('the Samsara service\'s missing names are warnings, and only once it has its own values', () => {
  const host = { JWT_SECRET: 'j', FACEBOOK_TOKEN_ENCRYPTION_KEY: 'f', BOT_TOKEN: T(1), TELEGRAM_BOT_TOKEN: T(2) };
  assert.deepEqual(rules.checkVersion({ hostEnv: host, items: [] }).warnings, []);
  const r = rules.checkVersion({ hostEnv: host, items: [{ scope: 'samsara', name: 'HARDCODED_GROUP_ID', value: '-100' }] });
  assert.equal(r.blocking.length, 0);
  assert.equal(r.warnings.length, 2);
});

test('what each service sees: its own scope over "both"', () => {
  const items = [
    { scope: 'both', name: 'A', value: '1' },
    { scope: 'samsara', name: 'A', value: '2' },
    { scope: 'bot', name: 'B', value: '3' },
  ];
  assert.deepEqual(rules.effectiveValues(items, 'samsara'), { A: '2' });
  assert.deepEqual(rules.effectiveValues(items, 'bot'), { A: '1', B: '3' });
});
