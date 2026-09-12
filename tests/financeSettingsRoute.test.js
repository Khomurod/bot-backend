'use strict';

/**
 * The Finance Monitor settings API.
 *
 * ONE RULE MATTERS MORE THAN THE REST HERE, and it is the reason this file
 * exists: the monitor cannot be switched on against a chat nobody validated.
 * Enabling it starts storing payment messages, so "which group?" must be a
 * question somebody answered on purpose, not a number that passed a regex.
 *
 * The second rule is what the status endpoint may say. It answers "is this
 * capturing, and does it look right" — a question that needs counts and needs
 * no message text, no code and no sender. `finance_messages.text` is meant to
 * live in exactly one place.
 *
 * The database and the Telegram client are stubbed through require.cache; this
 * is the HTTP layer's test, not the store's (tests/financeCapturePg.test.js).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET ||= 'test-secret';
process.env.BOT_TOKEN ||= '000:testbot';
process.env.TELEGRAM_BOT_TOKEN ||= '000:testnotif';
process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.DATABASE_URL ||= 'postgresql://localhost:5432/unused_in_this_test';

const ROOT = path.resolve(__dirname, '..');
const R = (rel) => path.resolve(ROOT, rel);
function stub(rel, exports) {
  const filename = require.resolve(R(rel));
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

let settingsRow = {
  id: 1, enabled: false, chat_id: null, chat_title: null, chat_validated_at: null,
  capture_documents: false, ai_reading_enabled: false, max_document_mb: 8,
  duplicate_window_hours: 72, weekly_report_enabled: false, weekly_report_chat_id: null,
  enabled_at: null, updated_at: '2026-09-01T00:00:00Z', updated_by: null,
};
/** Every statement the route layer caused, so a test can prove what was NOT run. */
let statements = [];
/** Telegram chat ids the groups table knows about, for the sign-flip check. */
let knownGroups = new Map();

stub('database/db.js', {
  query: async (text, values) => {
    statements.push(text);
    if (/UPDATE finance_settings/.test(text)) {
      settingsRow = {
        ...settingsRow,
        enabled: values[0], chat_id: values[1], chat_title: values[2],
        chat_validated_at: values[3], capture_documents: values[4],
        ai_reading_enabled: values[5], max_document_mb: values[6],
        duplicate_window_hours: values[7], weekly_report_enabled: values[8],
        weekly_report_chat_id: values[9], enabled_at: values[10],
      };
      return { rows: [settingsRow] };
    }
    if (/FROM finance_settings/.test(text)) return { rows: [settingsRow] };
    if (/FROM finance_messages/.test(text)) {
      return { rows: [{ status: 'parsed', count: 3 }, { status: 'not_moneycode', count: 9 }] };
    }
    if (/FROM finance_moneycodes/.test(text)) return { rows: [{ total: 3, duplicates: 1 }] };
    return { rows: [] };
  },
});
stub('database/groups.js', {
  getGroupByTelegramId: async (id) => knownGroups.get(String(id)),
});

const { createSettingsRouter } = require(R('server/routes/settingsRoutes'));
const financeSettings = require(R('database/financeSettings'));

const telegramStub = {
  getChat: async (id) => {
    if (String(id) === '-100404') throw new Error('Bad Request: chat not found');
    return { type: 'supergroup', title: 'Wenze Finance' };
  },
};

function makeServer({ auth = 'ok', telegram = telegramStub } = {}) {
  const app = express();
  app.use(express.json());
  const authMiddleware = auth === 'ok'
    ? (req, res, next) => { req.admin = { id: 5, username: 'tester' }; next(); }
    : (req, res) => res.status(401).json({ error: 'Unauthorized' });
  app.use('/api/settings', createSettingsRouter({ authMiddleware, telegram }));
  return http.createServer(app);
}

async function withServer(opts, fn) {
  statements = [];
  financeSettings.invalidateCache();
  const server = makeServer(opts);
  await new Promise((r) => server.listen(0, r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}/api/settings`);
  } finally {
    server.close();
  }
}
const J = { 'Content-Type': 'application/json' };

test('GET /finance answers with the monitor switched off', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/finance`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.enabled, false);
    assert.equal(body.chatId, null);
  });
});

test('every /finance route requires an administrator', async () => {
  await withServer({ auth: 'deny' }, async (base) => {
    for (const [method, url, body] of [
      ['GET', `${base}/finance`, undefined],
      ['GET', `${base}/finance/status`, undefined],
      ['PUT', `${base}/finance`, '{}'],
      ['POST', `${base}/finance/validate-chat`, '{}'],
    ]) {
      const res = await fetch(url, { method, headers: J, body });
      assert.equal(res.status, 401, `${method} ${url}`);
    }
    assert.deepEqual(statements, [], 'an unauthenticated call must not reach the database');
  });
});

test('it refuses to switch on without a validated chat', async () => {
  settingsRow = { ...settingsRow, enabled: false, chat_id: null, chat_validated_at: null };
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/finance`, { method: 'PUT', headers: J, body: JSON.stringify({ enabled: true }) });
    assert.equal(res.status, 400);
    assert.match((await res.json()).message, /Validate the finance group/);
    assert.equal(statements.some((s) => /UPDATE finance_settings/.test(s)), false,
      'a refused enable must not have written anything');
  });
});

test('validate-chat proves a candidate from the body and catches a dropped minus sign', async () => {
  knownGroups = new Map([['-100777', { group_name: 'Wenze Finance' }]]);
  await withServer({}, async (base) => {
    const ok = await fetch(`${base}/finance/validate-chat`, {
      method: 'POST', headers: J, body: JSON.stringify({ chatId: '-100777' }),
    });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.ok, true);
    assert.equal(body.chatTitle, 'Wenze Finance');

    // The failure that started all of this: 5052301861 saved cleanly and then
    // failed forever, because the real chat was -5052301861.
    const flipped = await fetch(`${base}/finance/validate-chat`, {
      method: 'POST', headers: J, body: JSON.stringify({ chatId: '100777' }),
    });
    assert.equal(flipped.status, 400);
    const flippedBody = await flipped.json();
    assert.equal(flippedBody.status, 'sign_flipped');
    assert.equal(flippedBody.suggestion, '-100777');

    const unreachable = await fetch(`${base}/finance/validate-chat`, {
      method: 'POST', headers: J, body: JSON.stringify({ chatId: '-100404' }),
    });
    assert.equal(unreachable.status, 400);
    assert.equal((await unreachable.json()).status, 'unreachable');
  });
  knownGroups = new Map();
});

test('a PUT carrying a chat validates it too, so enabling cannot be reached around the button', async () => {
  settingsRow = { ...settingsRow, enabled: false, chat_id: null, chat_validated_at: null };
  await withServer({}, async (base) => {
    const bad = await fetch(`${base}/finance`, {
      method: 'PUT', headers: J, body: JSON.stringify({ enabled: true, chatId: '-100404' }),
    });
    assert.equal(bad.status, 400);
    assert.equal(statements.some((s) => /UPDATE finance_settings/.test(s)), false);

    const good = await fetch(`${base}/finance`, {
      method: 'PUT', headers: J, body: JSON.stringify({ enabled: true, chatId: '-100777' }),
    });
    assert.equal(good.status, 200);
    const saved = await good.json();
    assert.equal(saved.enabled, true);
    assert.equal(saved.chatId, '-100777');
    // The title came from Telegram, so nobody has to type it.
    assert.equal(saved.chatTitle, 'Wenze Finance');
    assert.notEqual(saved.chatValidatedAt, null);
  });
});

test('the status endpoint reports counts and nothing that was said', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/finance/status`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.capture.total, 12);
    assert.deepEqual(body.capture.byStatus, { parsed: 3, not_moneycode: 9 });
    assert.equal(body.capture.codes, 3);
    assert.equal(body.capture.duplicates, 1);

    // Structural, not a spot-check: nothing in the response may be a message,
    // a code or a sender, whatever the shape grows into later.
    const flat = JSON.stringify(body);
    for (const forbidden of ['text', 'code_normalized', 'sender', 'message_id']) {
      assert.equal(flat.includes(forbidden), false, `the status response leaked "${forbidden}"`);
    }
  });
});
