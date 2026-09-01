/**
 * BOL/POD forwarding must NOT relay document bytes through Render.
 *
 * The normal path hands Telegram the Datatruck URL and lets TELEGRAM'S SERVERS
 * fetch the file; only when Telegram cannot (over its ~20MB URL limit, an
 * expired presigned link, a URL needing the Datatruck token) do we download and
 * upload the bytes ourselves. On a metered plan that difference is the whole
 * cost of the feature — a day of PDFs either costs nothing or costs twice their
 * size, inbound plus outbound.
 *
 * The trap this guards is that `Input.fromURL` and `Input.fromURLStream` look
 * interchangeable and are not, so these tests assert against the REAL Telegraf
 * (not a stub of it) and against what the service actually hands `sendDocument`.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { Input } = require('telegraf');

// ── Telegraf transport semantics (the reason the service is written this way) ──

test('Input.fromURL yields a bare string — Telegram fetches, Render does not', () => {
  const value = Input.fromURL('https://datatruck.example/doc/bol-123.pdf');

  assert.equal(typeof value, 'string', 'a string payload is sent as a plain form field');
  assert.equal(value, 'https://datatruck.example/doc/bol-123.pdf');
  // Nothing here can carry bytes: there is no stream, buffer or source to read.
  assert.equal(typeof value === 'object', false);
});

test('Input.fromURL takes ONE argument — a filename passed to it is ignored', () => {
  // Documents the accepted trade-off: on the direct path Telegram names the
  // file from the URL. Recovering the pretty name would require fromURLStream,
  // which relays every byte through Render.
  const withFilename = Input.fromURL('https://datatruck.example/doc/x.pdf', 'BOL_9912.pdf');
  assert.equal(withFilename, 'https://datatruck.example/doc/x.pdf');
  assert.ok(!String(withFilename).includes('BOL_9912'), 'the filename is not encoded anywhere');
});

test('Input.fromURLStream is the byte-relaying twin — never use it here', () => {
  const value = Input.fromURLStream('https://datatruck.example/doc/x.pdf', 'BOL_9912.pdf');

  // Telegraf fetches this URL itself and pipes the response into a multipart
  // upload (telegraf/lib/core/network/client.js → attachFormMedia), so the
  // bytes travel Datatruck → Render → Telegram.
  assert.equal(typeof value, 'object');
  assert.equal(value.url, 'https://datatruck.example/doc/x.pdf');
  assert.equal(value.filename, 'BOL_9912.pdf');
});

test('Input.fromBuffer is the deliberate fallback shape', () => {
  const value = Input.fromBuffer(Buffer.from('%PDF-1.4'), 'BOL_9912.pdf');
  assert.ok(Buffer.isBuffer(value.source), 'carries the bytes, on purpose');
  assert.equal(value.filename, 'BOL_9912.pdf', 'and the filename DOES apply here');
});

// ── what the service actually sends ──

function loadService({ sendDocument, fetchImpl, apiToken = 'dt-token' } = {}) {
  const servicePath = path.resolve(__dirname, '../services/datatruckDocumentService.js');
  const configPath = path.resolve(__dirname, '../config/config.js');
  const botPath = path.resolve(__dirname, '../bot/bot.js');
  const htmlPath = path.resolve(__dirname, '../services/telegramHtml.js');

  delete require.cache[servicePath];
  // NOTE: telegraf is deliberately NOT stubbed — the point is the real Input.
  require.cache[configPath] = {
    exports: {
      datatruckApiToken: apiToken,
      datatruckDocMaxFileMb: 20,
      datatruckDocMediaBaseUrl: '',
      datatruckDocLookbackDays: 2,
      datatruckDocPollMinutes: 15,
      datatruckDocDeliveryEnabled: true,
    },
  };
  require.cache[botPath] = { exports: { bot: { telegram: { sendDocument } } } };
  require.cache[htmlPath] = {
    exports: {
      safeSend: async (fn) => fn(),
      // Only chat-level failures are permanent; a URL-fetch failure is not.
      isPermanentSendError: (err) => err?.response?.error_code === 403,
    },
  };

  const previousFetch = global.fetch;
  if (fetchImpl) global.fetch = fetchImpl;

  const service = require(servicePath);
  return {
    service,
    restore() {
      global.fetch = previousFetch;
      delete require.cache[servicePath];
      delete require.cache[configPath];
      delete require.cache[botPath];
      delete require.cache[htmlPath];
    },
  };
}

const BOL = {
  fileType: 'bill_of_lading',
  fileLink: 'https://files.datatruck.example/signed/bol-4471.pdf?expires=1',
  loadReference: '4471',
  orderId: 'o-4471',
};

test('the happy path sends the URL as a string and reads no bytes', async () => {
  const sent = [];
  let fetchCalls = 0;
  const { service, restore } = loadService({
    sendDocument: async (chatId, media, extra) => { sent.push({ chatId, media, extra }); return { message_id: 1 }; },
    fetchImpl: async () => { fetchCalls += 1; throw new Error('the service must not download on the happy path'); },
  });

  try {
    await service.sendDocumentToGroup('-1002614', BOL);

    assert.equal(sent.length, 1);
    assert.equal(
      typeof sent[0].media,
      'string',
      'sendDocument received a bare URL string, so Telegram does the fetching',
    );
    assert.equal(sent[0].media, BOL.fileLink);
    assert.equal(fetchCalls, 0, 'Render never opened the document');
  } finally {
    restore();
  }
});

test('when Telegram cannot fetch the URL, Render relays the bytes', async () => {
  const sent = [];
  const pdf = Buffer.from('%PDF-1.4 scanned bill of lading');
  let attempt = 0;
  const { service, restore } = loadService({
    sendDocument: async (chatId, media, extra) => {
      attempt += 1;
      if (attempt === 1) {
        // Exactly what Telegram returns for an expired or unreachable link.
        const err = new Error('Bad Request: failed to get HTTP URL content');
        err.response = { error_code: 400, description: 'failed to get HTTP URL content' };
        throw err;
      }
      sent.push({ chatId, media, extra });
      return { message_id: 2 };
    },
    fetchImpl: async () => ({
      ok: true,
      headers: { get: () => String(pdf.length) },
      arrayBuffer: async () => pdf,
    }),
  });

  try {
    const result = await service.sendDocumentToGroup('-1002614', BOL);

    assert.equal(result.message_id, 2, 'delivery still succeeded');
    assert.equal(sent.length, 1);
    assert.ok(Buffer.isBuffer(sent[0].media.source), 'the fallback uploaded the bytes');
    assert.ok(sent[0].media.filename.includes('4471'), 'and the filename applies on this path');
  } finally {
    restore();
  }
});

test('a permanent chat error is not masked by a pointless download', async () => {
  let fetchCalls = 0;
  const { service, restore } = loadService({
    sendDocument: async () => {
      const err = new Error('Forbidden: bot was kicked');
      err.response = { error_code: 403, description: 'bot was kicked from the group chat' };
      throw err;
    },
    fetchImpl: async () => { fetchCalls += 1; return { ok: true, headers: { get: () => '10' }, arrayBuffer: async () => Buffer.alloc(10) }; },
  });

  try {
    await assert.rejects(() => service.sendDocumentToGroup('-1002614', BOL), /kicked/);
    assert.equal(fetchCalls, 0, 'no wasted download for a chat that cannot receive it');
  } finally {
    restore();
  }
});

// ── authenticated / presigned Datatruck URLs ──

test('the fallback download retries with the API token when access is denied', async () => {
  const seen = [];
  const pdf = Buffer.from('%PDF-1.4 authenticated');
  const { service, restore } = loadService({
    sendDocument: async () => ({ message_id: 3 }),
    fetchImpl: async (url, opts) => {
      seen.push(opts?.headers?.Authorization || null);
      if (seen.length === 1) {
        // Presigned link expired, or the URL needs the account token.
        return { ok: false, status: 403, headers: { get: () => null } };
      }
      return { ok: true, headers: { get: () => String(pdf.length) }, arrayBuffer: async () => pdf };
    },
  });

  try {
    const buffer = await service.downloadDocument('https://files.datatruck.example/private/bol.pdf');

    assert.deepEqual(seen, [null, 'Token dt-token'], 'unauthenticated first, then with the token');
    assert.ok(buffer.equals(pdf));
  } finally {
    restore();
  }
});

test('an oversize document is refused before it is buffered into memory', async () => {
  const { service, restore } = loadService({
    sendDocument: async () => ({ message_id: 4 }),
    fetchImpl: async () => ({
      ok: true,
      // 40MB declared — twice the configured cap.
      headers: { get: (h) => (h === 'content-length' ? String(40 * 1024 * 1024) : null) },
      arrayBuffer: async () => { throw new Error('must not read the body'); },
    }),
  });

  try {
    await assert.rejects(
      () => service.downloadDocument('https://files.datatruck.example/huge.pdf'),
      /too large/i,
    );
  } finally {
    restore();
  }
});
