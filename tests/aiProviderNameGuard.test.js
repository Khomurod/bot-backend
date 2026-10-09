'use strict';

/**
 * An AI provider's NAME is never a pasted API key.
 *
 * October 2026: production held a disabled provider whose operator-typed name
 * was an OpenRouter key, pasted into the wrong field. A name is shown in the
 * admin and written to logs; a key is encrypted and never shown.
 */
process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.DATABASE_URL ||= 'postgresql://user:password@127.0.0.1:1/test';
process.env.JWT_SECRET ||= 'test-jwt-secret';

const test = require('node:test');
const assert = require('node:assert/strict');

const { looksLikeSecret } = require('../lib/security/secretMasking');

// Shapes only: every "key" below is made up.
const FAKE_OPENROUTER = `sk-or-v1-${'a1b2c3d4'.repeat(8)}`;
const FAKE_GROQ = `gsk_${'Zx9Yw8Vu7'.repeat(5)}`;
const FAKE_GOOGLE = `AIza${'Sy0aB1cD2eF3'.repeat(3)}`;
const FAKE_OPAQUE = 'Q7w3E9r1T5y8U2i6O4p0A7s3D9f1G5h8';

test('a pasted key is recognised; an ordinary name is not', () => {
  for (const key of [FAKE_OPENROUTER, FAKE_GROQ, FAKE_GOOGLE, FAKE_OPAQUE, `  ${FAKE_GROQ}  `]) {
    assert.equal(looksLikeSecret(key), true, key.slice(0, 12));
  }
  for (const name of ['groq', 'openrouter', 'gemini', 'custom', 'my_llm', 'office-box',
    'OpenRouter (backup)', 'sk-test', 'gemini-2.5-flash-preview-0520', '', null, undefined]) {
    assert.equal(looksLikeSecret(name), false, String(name));
  }
});

test('THE DATA LAYER refuses a key as a provider name or label — before any statement is sent', async () => {
  const sent = [];
  require.cache[require.resolve('pg')] = {
    exports: { Pool: class { on() {} async query(q) { sent.push(q); return { rows: [] }; } } },
  };
  // eslint-disable-next-line global-require
  const aiProviders = require('../database/aiProviders');
  await assert.rejects(() => aiProviders.upsertProvider(FAKE_OPENROUTER, { label: 'OpenRouter' }),
    (err) => err.statusCode === 400 && /looks like an API key/.test(err.message));
  await assert.rejects(() => aiProviders.upsertProvider('openrouter', { label: FAKE_OPENROUTER }),
    (err) => err.statusCode === 400 && /label/.test(err.message));
  assert.deepEqual(sent, [], 'nothing reached the database');
  assert.ok(!/a1b2c3d4/.test(String((await aiProviders.upsertProvider(FAKE_GROQ).catch((e) => e)).message)),
    'and the refusal never echoes the key');
});

test('the settings route answers 400 in plain words', async (t) => {
  const express = require('express');
  const path = require('node:path');
  const routesPath = path.resolve(__dirname, '../server/routes/settings/aiRoutes.js');
  const providersPath = path.resolve(__dirname, '../database/aiProviders.js');
  delete require.cache[routesPath];
  const real = require(providersPath);
  require.cache[providersPath] = {
    id: providersPath, filename: providersPath, loaded: true,
    exports: { ...real, upsertProvider: real.upsertProvider },
  };
  t.after(() => { delete require.cache[routesPath]; delete require.cache[providersPath]; });
  // eslint-disable-next-line global-require
  const mod = require(routesPath);
  const create = mod.createAiSettingsRouter;
  const app = express();
  app.use(express.json());
  app.use(create({ authMiddleware: (req, _res, next) => { req.admin = { username: 'test' }; next(); } }));
  const server = app.listen(0);
  t.after(() => new Promise((r) => server.close(r)));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/ai/providers/${encodeURIComponent(FAKE_GROQ)}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'Groq' }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /looks like an API key/);
  assert.ok(!body.error.includes('Zx9Yw8Vu7'), 'the answer does not repeat the key');
});
