'use strict';

/**
 * Fetching one document's bytes, and the two things that must never happen.
 *
 * THE URL CONTAINS THE BOT TOKEN. `getFileLink` returns
 * `https://api.telegram.org/file/bot<TOKEN>/…`, which is a live credential in a
 * string. Every error this module raises is built from a status code or an
 * error NAME, never from a message that could carry the URL through — and that
 * is asserted here rather than trusted, because the natural way to write an
 * error handler is `err.message`.
 *
 * THE SIZE CAP HOLDS EVEN WHEN THE HEADER LIES. A declared `content-length` can
 * be wrong or absent, so the bytes are counted as they arrive and the transfer
 * is aborted the moment it passes. On a 512MB instance that second check is
 * what stops one bad document taking the process with it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { downloadFinanceFile, FinanceDownloadError } = require('../services/finance/telegramFileDownload');

const TOKEN = '7777777:AAFAKEfaketokenNEVERreal';
const LINK = `https://api.telegram.org/file/bot${TOKEN}/documents/file_1.pdf`;

const telegram = { getFileLink: async () => LINK };

/** A Response-alike whose body streams in chunks of the given size. */
function streamingResponse(totalBytes, { chunk = 1024, headers = {}, status = 200 } = {}) {
  let sent = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    body: {
      getReader: () => ({
        read: async () => {
          if (sent >= totalBytes) return { done: true, value: undefined };
          const size = Math.min(chunk, totalBytes - sent);
          sent += size;
          return { done: false, value: new Uint8Array(size) };
        },
        cancel: async () => {},
      }),
    },
    arrayBuffer: async () => new ArrayBuffer(totalBytes),
  };
}

test('a normal file comes back as a buffer', async () => {
  const fetchImpl = async () => streamingResponse(2048);
  const buffer = await downloadFinanceFile({ telegram, fetchImpl }, 'f1', { maxBytes: 8 * 1024 * 1024 });
  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(buffer.length, 2048);
});

test('a declared size over the cap ends it before a byte is read', async () => {
  let read = false;
  const fetchImpl = async () => {
    const res = streamingResponse(100, { headers: { 'content-length': String(50 * 1024 * 1024) } });
    const inner = res.body.getReader;
    res.body.getReader = () => { read = true; return inner(); };
    return res;
  };
  await assert.rejects(
    () => downloadFinanceFile({ telegram, fetchImpl }, 'f1', { maxBytes: 1024 }),
    (err) => err instanceof FinanceDownloadError && err.kind === 'too_large',
  );
  assert.equal(read, false, 'the body must not be touched once the header has answered');
});

test('the cap still holds when the header lies, or is missing', async () => {
  // No content-length at all, and ten times the cap arriving in chunks.
  const fetchImpl = async () => streamingResponse(10 * 1024, { chunk: 512 });
  await assert.rejects(
    () => downloadFinanceFile({ telegram, fetchImpl }, 'f1', { maxBytes: 2048 }),
    (err) => err.kind === 'too_large',
  );
});

test('the cap holds on a body that cannot be streamed', async () => {
  const fetchImpl = async () => ({
    ok: true, status: 200,
    headers: { get: () => null },
    body: null,
    arrayBuffer: async () => new ArrayBuffer(9999),
  });
  await assert.rejects(
    () => downloadFinanceFile({ telegram, fetchImpl }, 'f1', { maxBytes: 100 }),
    (err) => err.kind === 'too_large',
  );
});

test('NO ERROR EVER CARRIES THE URL OR THE TOKEN', async () => {
  const cases = [
    // Telegram refuses to give a link, and its message quotes the request.
    {
      deps: {
        telegram: {
          getFileLink: async () => {
            const err = new Error(`400: Bad Request for ${LINK}`);
            err.name = 'TelegramError';
            throw err;
          },
        },
        fetchImpl: async () => streamingResponse(10),
      },
    },
    // fetch throws, with the URL in its message the way node's does.
    {
      deps: {
        telegram,
        fetchImpl: async () => { throw new Error(`request to ${LINK} failed`); },
      },
    },
    // A non-2xx answer.
    { deps: { telegram, fetchImpl: async () => streamingResponse(0, { status: 403 }) } },
    // A timeout.
    {
      deps: {
        telegram,
        fetchImpl: async () => {
          const err = new Error(`aborted fetching ${LINK}`);
          err.name = 'AbortError';
          throw err;
        },
      },
    },
  ];

  for (const { deps } of cases) {
    let raised = null;
    try {
      await downloadFinanceFile(deps, 'f1', { maxBytes: 1024, timeoutMs: 50 });
    } catch (err) {
      raised = err;
    }
    assert.ok(raised, 'it should have failed');
    const text = `${raised.message} ${raised.stack || ''}`;
    assert.ok(!text.includes(TOKEN), `the bot token leaked: ${raised.message}`);
    assert.ok(!text.includes('api.telegram.org'), `the URL leaked: ${raised.message}`);
  }
});

test('a timeout is named as one, so the queue can tell it from a refusal', async () => {
  const fetchImpl = async () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  };
  await assert.rejects(
    () => downloadFinanceFile({ telegram, fetchImpl }, 'f1', { maxBytes: 1024, timeoutMs: 3000 }),
    (err) => err.kind === 'timeout' && /3s/.test(err.message),
  );
});

test('an HTTP status is reported, because a status is safe and a URL is not', async () => {
  const fetchImpl = async () => streamingResponse(0, { status: 404 });
  await assert.rejects(
    () => downloadFinanceFile({ telegram, fetchImpl }, 'f1', { maxBytes: 1024 }),
    (err) => err.kind === 'http_error' && /404/.test(err.message),
  );
});

test('it refuses to run with no client and no limit rather than guessing one', async () => {
  await assert.rejects(
    () => downloadFinanceFile({ telegram: null }, 'f1', { maxBytes: 10 }),
    (err) => err.kind === 'no_client',
  );
  await assert.rejects(
    () => downloadFinanceFile({ telegram, fetchImpl: async () => streamingResponse(10) }, 'f1', {}),
    (err) => err.kind === 'bad_limit',
  );
});
