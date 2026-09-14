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
    // `error`, the key the admin client actually reads. It was `message`, so
    // this refusal reached the screen as a bare "HTTP Error: 400".
    assert.match((await res.json()).error, /Validate the finance group/);
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
    // A VERDICT IS 200. The request succeeded; the answer was no. This used to
    // be a 400, which made the admin client throw — so the tab's rendering of
    // `out.ok === false`, including the one-click "did you mean -100777?", was
    // unreachable and the screen showed the status code instead.
    const flipped = await fetch(`${base}/finance/validate-chat`, {
      method: 'POST', headers: J, body: JSON.stringify({ chatId: '100777' }),
    });
    assert.equal(flipped.status, 200, 'a negative verdict is still a successful request');
    const flippedBody = await flipped.json();
    assert.equal(flippedBody.ok, false);
    assert.equal(flippedBody.status, 'sign_flipped');
    assert.equal(flippedBody.suggestion, '-100777');
    assert.match(flippedBody.message, /Did you mean -100777/);

    const unreachable = await fetch(`${base}/finance/validate-chat`, {
      method: 'POST', headers: J, body: JSON.stringify({ chatId: '-100404' }),
    });
    assert.equal(unreachable.status, 200);
    const unreachableBody = await unreachable.json();
    assert.equal(unreachableBody.ok, false);
    assert.equal(unreachableBody.status, 'unreachable');
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

// ── the two chats are not the same kind of thing ───────────────────────────

/**
 * THE CAPTURE GROUP IS A ROOM; THE WEEKLY SUMMARY IS A REPORT SOMEBODY READS.
 *
 * Found in production: saving `5142950669` as the report destination failed
 * with a 400 on every attempt — the field saves on blur, so it failed on every
 * blur — and the screen could only say "HTTP Error: 400".
 *
 * A positive id is a user id, and `checkChatId` refuses a private chat unless
 * the caller opts in. Notification routing and the AI policy watcher both opt
 * in, for the stated reason that a small operation may want these in one
 * administrator's direct messages. A weekly money-code summary is the same kind
 * of thing and this field was the odd one out.
 *
 * The capture group is NOT: every message in it is stored verbatim, and one
 * person's direct messages is not something to point that at.
 */
test('the weekly report may go to one person; the capture group may not', async () => {
  const withPrivate = {
    getChat: async (id) => (String(id).startsWith('-')
      ? { type: 'supergroup', title: 'Wenze Finance' }
      : { type: 'private', first_name: 'Wenze', last_name: 'Owner' }),
  };
  settingsRow = { ...settingsRow, chat_id: '-100777', chat_validated_at: '2026-09-01T00:00:00Z' };

  await withServer({ telegram: withPrivate }, async (base) => {
    const report = await fetch(`${base}/finance`, {
      method: 'PUT', headers: J, body: JSON.stringify({ weeklyReportChatId: '5142950669' }),
    });
    assert.equal(report.status, 200, 'a person is a valid destination for a report');
    assert.equal((await report.json()).weeklyReportChatId, '5142950669');

    const capture = await fetch(`${base}/finance`, {
      method: 'PUT', headers: J, body: JSON.stringify({ chatId: '5142950669' }),
    });
    assert.equal(capture.status, 400, 'the room whose traffic is recorded must be a room');
    const body = await capture.json();
    assert.match(body.error, /not a group/);
    assert.equal(body.field, 'chatId', 'and it names which field, so the screen can point at it');
  });
});

/**
 * THE SIGN-FLIP CHECK STILL RUNS FIRST.
 *
 * `allowPrivate` is only reached after the dropped-minus branch, and that
 * ordering is load-bearing: a positive id resolves to a private chat perfectly
 * well, so probing first would ACCEPT the typo that this whole check was
 * written to catch. Opting into private destinations must not reopen it.
 */
test('a dropped minus sign is still caught on the report chat, private or not', async () => {
  knownGroups = new Map([['-100777', { group_name: 'Wenze Finance' }]]);
  const withPrivate = {
    getChat: async () => ({ type: 'private', first_name: 'Wenze' }),
  };
  await withServer({ telegram: withPrivate }, async (base) => {
    const res = await fetch(`${base}/finance`, {
      method: 'PUT', headers: J, body: JSON.stringify({ weeklyReportChatId: '100777' }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.status, 'sign_flipped');
    assert.equal(body.suggestion, '-100777');
    assert.equal(body.field, 'weeklyReportChatId');
    assert.equal(statements.some((s) => /UPDATE finance_settings/.test(s)), false);
  });
  knownGroups = new Map();
});

/**
 * EVERY 400 THIS FILE CAN PRODUCE CARRIES `error`.
 *
 * Structural rather than a spot-check: `message` is the key the admin client
 * does NOT read, and three bodies here used it. One more added later would be
 * invisible on the screen in exactly the same way.
 */
test('no 400 from the finance settings routes answers with `message` alone', async () => {
  const src = require('node:fs').readFileSync(
    require.resolve(R('server/routes/settings/financeRoutes')), 'utf8'
  );
  const badBodies = [...src.matchAll(/res\.status\(400\)\.json\(\{([\s\S]{0,120}?)\}\)/g)]
    .map((m) => m[1])
    .filter((body) => !/\berror:/.test(body));
  assert.deepEqual(badBodies, [],
    'a 400 body without `error` is an explanation the admin renders as the status code');
});
