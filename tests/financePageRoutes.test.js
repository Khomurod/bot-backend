'use strict';

/**
 * The Finance page's API — the ONE place captured payment text leaves the
 * database, and therefore the one that most needs its edges pinned.
 *
 *   EVERY ROUTE IS BEHIND THE ADMIN GATE, and an unauthenticated call must not
 *   reach the database at all — not "returns 401 after querying".
 *
 *   NOTHING HERE WRITES A VALUE. The two actions re-run machinery that already
 *   exists (re-read a message with the current parser, re-queue a document) and
 *   neither takes an amount, a code or a status from the caller. A structural
 *   test asserts the router contains no such write.
 *
 *   THE TELEGRAM LINK IS BUILT SERVER-SIDE from the stored ids. Accepting one
 *   from the client would put an attacker-chosen URL on a payments screen.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET ||= 'test-secret';
process.env.BOT_TOKEN ||= '000:testbot';
process.env.DATABASE_URL ||= 'postgresql://localhost:5432/unused_in_this_test';

const ROOT = path.resolve(__dirname, '..');
const R = (rel) => path.resolve(ROOT, rel);
function stub(rel, exports) {
  const filename = require.resolve(R(rel));
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

let statements = [];
let messages = [];
let moneycodes = [];
let documents = [];
let reports = [];
let reparsed = [];
let requeued = [];
let requeueResult = true;
let reparseResult = { id: 1, before: 'ambiguous', after: 'parsed' };

stub('database/db.js', { query: async (text) => { statements.push(text); return { rows: [] }; } });
stub('database/financeMessages.js', {
  listMessages: async (o) => { statements.push('listMessages'); return messages.filter((m) => !o.status || m.parseStatus === o.status); },
  listMoneycodes: async () => { statements.push('listMoneycodes'); return moneycodes; },
  reparseMessage: async (id) => { reparsed.push(id); return reparseResult; },
});
stub('database/financeDocuments.js', {
  listDocuments: async () => { statements.push('listDocuments'); return documents; },
  requeueDocument: async (id) => { requeued.push(id); return requeueResult; },
});
let pokes = 0;
stub('services/finance/documentReader.js', {
  wakeFinanceDocumentReader: () => { pokes += 1; },
});
stub('services/finance/captureService.js', {
  reparseCapturedMessage: async (id) => { reparsed.push(id); return reparseResult; },
});
stub('database/finance/reports.js', {
  listReports: async () => { statements.push('listReports'); return reports; },
});
stub('database/financeSettings.js', {
  getFinanceSettings: async () => ({ enabled: true, chatId: '-100777' }),
  invalidateCache: () => {},
});
let sentNow = [];
let sendNowResult = { sent: true, periodStart: '2026-09-01', telegramMessageId: 77 };
stub('services/finance/weeklyReportService.js', {
  previewReport: async () => { statements.push('previewReport'); return { periodStart: '2026-09-01', periodEnd: '2026-09-07', totals: { issued: 3 }, body: '<b>x</b>' }; },
  sendReportNow: async (deps) => { sentNow.push(deps); return sendNowResult; },
});

const { createFinanceRouter, MAX_LIMIT } = require(R('server/routes/financeRoutes'));
const { buildTelegramMessageUrl } = require(R('services/telegramUrl'));

function makeServer({ auth = 'ok' } = {}) {
  const app = express();
  app.use(express.json());
  const authMiddleware = auth === 'ok'
    ? (req, res, next) => { req.admin = { id: 5, username: 'tester' }; next(); }
    : (req, res) => res.status(401).json({ error: 'Unauthorized' });
  app.use('/api/finance', createFinanceRouter({ authMiddleware, buildMessageUrl: buildTelegramMessageUrl }));
  return http.createServer(app);
}

async function withServer(opts, fn) {
  statements = []; reparsed = []; requeued = []; sentNow = []; pokes = 0;
  const server = makeServer(opts);
  await new Promise((r) => server.listen(0, r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}/api/finance`);
  } finally {
    server.close();
  }
}

test('EVERY route requires an administrator, and refuses before touching the database', async () => {
  await withServer({ auth: 'deny' }, async (base) => {
    for (const [method, url] of [
      ['GET', `${base}/messages`],
      ['GET', `${base}/moneycodes`],
      ['GET', `${base}/documents`],
      ['GET', `${base}/reports`],
      ['POST', `${base}/messages/1/reparse`],
      ['POST', `${base}/documents/1/retry`],
      ['GET', `${base}/reports/preview`],
      ['POST', `${base}/reports/send-now`],
    ]) {
      const res = await fetch(url, { method });
      assert.equal(res.status, 401, `${method} ${url}`);
    }
    assert.deepEqual(statements, [], 'an unauthenticated call must not reach the database');
    assert.deepEqual(reparsed, []);
    assert.deepEqual(requeued, []);
    assert.deepEqual(sentNow, [], 'an unauthenticated call must not send anything to Telegram');
    assert.equal(pokes, 0);
  });
});

test('the messages come back WITH their text — this is the one place that happens', async () => {
  messages = [{
    id: 1, chatId: '-1001234567890', messageId: 55, senderName: 'A Poster',
    text: 'money code 1111 2222 3333 for $500', parseStatus: 'parsed',
  }];
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/messages`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.messages[0].text, 'money code 1111 2222 3333 for $500');
  });
});

test('the Telegram link is BUILT here, never taken from the client', async () => {
  messages = [
    { id: 1, chatId: '-1001234567890', messageId: 55, text: 'a', parseStatus: 'parsed' },
    // A chat Telegram has no link shape for: null, not a guess. A broken link
    // on a payments screen is worse than none.
    { id: 2, chatId: '-4477', messageId: 9, text: 'b', parseStatus: 'parsed' },
  ];
  await withServer({}, async (base) => {
    const { messages: out } = await (await fetch(`${base}/messages`)).json();
    assert.equal(out[0].telegramUrl, 'https://t.me/c/1234567890/55');
    assert.equal(out[1].telegramUrl, null);
  });

  // And a URL offered by the caller is ignored outright.
  await withServer({}, async (base) => {
    const { messages: out } = await (await fetch(`${base}/messages?telegramUrl=https://evil.example`)).json();
    assert.equal(out[0].telegramUrl, 'https://t.me/c/1234567890/55');
  });
});

test('the status filter is what makes the unreadable pile workable', async () => {
  messages = [
    { id: 1, chatId: '-100', messageId: 1, text: 'a', parseStatus: 'parsed' },
    { id: 2, chatId: '-100', messageId: 2, text: 'b', parseStatus: 'ambiguous' },
  ];
  await withServer({}, async (base) => {
    const { messages: out } = await (await fetch(`${base}/messages?status=ambiguous`)).json();
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 2);
  });
});

test('a caller cannot ask for the whole table', async () => {
  const captured = [];
  const filename = require.resolve(R('database/financeMessages.js'));
  const original = require.cache[filename].exports.listMessages;
  require.cache[filename].exports.listMessages = async (o) => { captured.push(o.limit); return []; };
  try {
    await withServer({}, async (base) => {
      await fetch(`${base}/messages?limit=99999`);
      await fetch(`${base}/messages?limit=-4`);
      await fetch(`${base}/messages?limit=banana`);
      await fetch(`${base}/messages?limit=25`);
    });
    assert.deepEqual(captured, [MAX_LIMIT, 50, 50, 25]);
  } finally {
    require.cache[filename].exports.listMessages = original;
  }
});

test('re-reading a message passes an id and nothing else', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/messages/7/reparse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // A caller trying to dictate the answer. The route takes the id only.
      body: JSON.stringify({ parseStatus: 'parsed', amount: 999999, code: 'MINE' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(reparsed, [7]);
    const body = await res.json();
    assert.equal(body.after, 'parsed');
  });
});

test('re-reading something that is not there is a 404, not a silent success', async () => {
  const filename = require.resolve(R('services/finance/captureService.js'));
  const original = require.cache[filename].exports.reparseCapturedMessage;
  require.cache[filename].exports.reparseCapturedMessage = async () => null;
  try {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/messages/999/reparse`, { method: 'POST' });
      assert.equal(res.status, 404);
    });
  } finally {
    require.cache[filename].exports.reparseCapturedMessage = original;
  }
});

test('a document that cannot be re-queued says so rather than pretending', async () => {
  requeueResult = false;
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/documents/3/retry`, { method: 'POST' });
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /already queued/);
  });
  requeueResult = true;
});

test('THE ROUTER WRITES NO BUSINESS VALUE — structurally', () => {
  const source = require('node:fs').readFileSync(R('server/routes/financeRoutes.js'), 'utf8');
  // It may read, and it may ask existing machinery to run again. It may not
  // set an amount, a code, a status or a total from a request body.
  for (const forbidden of ['UPDATE ', 'INSERT ', 'req.body']) {
    assert.equal(source.includes(forbidden), false,
      `the Finance page router started writing: ${forbidden}`);
  }
});

test('the preview shows the figures and sends nothing', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/reports/preview`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.totals, { issued: 3 });
    assert.equal(body.body, '<b>x</b>');
    assert.deepEqual(sentNow, [], 'a preview must not reach a chat');
  });
});

/**
 * The Telegram client is the router's, not the caller's. A "send now" that
 * accepted a chat id from the request body would turn a payments summary into
 * an open relay.
 */
test('send now hands the service the SERVER\'s Telegram client', async () => {
  const telegram = { sendMessage: async () => ({ message_id: 1 }) };
  const app = express();
  app.use(express.json());
  app.use('/api/finance', createFinanceRouter({
    authMiddleware: (req, res, next) => { req.admin = { id: 5 }; next(); },
    telegram,
  }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  try {
    sentNow = [];
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/finance/reports/send-now`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: '-100EVIL' }),
    });
    assert.equal(res.status, 200);
    assert.equal(sentNow.length, 1);
    assert.equal(sentNow[0].telegram, telegram);
    assert.equal(sentNow[0].chatId, undefined, 'nothing from the body may reach the send');
  } finally {
    server.close();
  }
});

/**
 * "No chat is set" is an ANSWER, not a crash. A 500 would send the person to
 * the logs for something the screen can simply say.
 */
test('a refusal to send is a 400 carrying the reason', async () => {
  sendNowResult = { sent: false, reason: 'No chat is set for the finance report.' };
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/reports/send-now`, { method: 'POST' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /No chat is set/);
  });
  sendNowResult = { sent: true, periodStart: '2026-09-01', telegramMessageId: 77 };
});

/**
 * THE POKE IS WHAT MAKES "within a few minutes" TRUE.
 *
 * After an empty drain the queue scheduler holds no retry timer — only the
 * 15-minute idle sweep — so a row made due right now would sit untouched for a
 * quarter of an hour while the screen promised otherwise.
 */
test('a retry wakes the reader, exactly as capture does', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/documents/3/retry`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.deepEqual(requeued, [3]);
    assert.equal(pokes, 1, 'the reader must be poked after a successful requeue');
  });
});

/** A requeue that changed nothing must not poke a worker for no reason. */
test('a retry that changed nothing does not wake the reader', async () => {
  requeueResult = false;
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/documents/3/retry`, { method: 'POST' });
    assert.equal(res.status, 404);
    assert.equal(pokes, 0);
  });
  requeueResult = true;
});

/**
 * The route goes through the CAPTURE SERVICE, not the table. A re-read that
 * reached the database directly moved the message off the unclear pile and left
 * the money code behind.
 */
test('a re-read goes through the service that records the code', async () => {
  const source = require('node:fs').readFileSync(R('server/routes/financeRoutes.js'), 'utf8');
  assert.ok(source.includes('captureService.reparseCapturedMessage'),
    'the route must not call financeMessages.reparseMessage directly');
  assert.equal(source.includes('financeMessages.reparseMessage'), false);
});
