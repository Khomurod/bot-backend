'use strict';

/**
 * Getting one attachment's bytes out of Telegram, safely.
 *
 * Used by Safety Approvals (services/safetyApprovals/worker.js) to read the
 * photo or document a post carries. MOVED here from
 * services/finance/telegramFileDownload.js when the Finance Monitor was
 * removed (October 2026, docs/architecture/retired-finance-monitor.md); it was
 * never finance-specific.
 *
 * THE URL TELEGRAM HANDS BACK CONTAINS THE BOT TOKEN. `getFileLink` returns
 * `https://api.telegram.org/file/bot<TOKEN>/...`, which is a live credential in
 * a string. It is never logged, never stored, never put in an error message,
 * and a caller must never give it a column to go in.
 * Every error raised here is constructed from a status code or an error NAME,
 * never from a message that might carry the URL through.
 *
 * THE SIZE IS REFUSED TWICE, AND BOTH TIMES MATTER. Telegram's declared
 * `file_size` is checked BEFORE the request — a cap enforced after the download
 * has already paid the cost it exists to prevent. But a declared size can be
 * wrong or absent, so the bytes are counted as they arrive and the transfer is
 * aborted the moment it passes the cap. On a 512MB instance, the second check
 * is what stops one bad document from taking the process down with it.
 *
 * NOTHING IS RETRIED HERE. A failure returns and the queue's backoff decides
 * whether to come back, because a retry loop inside a download is a retry loop
 * nobody can see or bound.
 */

const DEFAULT_TIMEOUT_MS = 60_000;

/** A download that failed, with a reason safe to store. */
class TelegramDownloadError extends Error {
  constructor(message, { kind = 'download_failed' } = {}) {
    super(message);
    this.name = 'TelegramDownloadError';
    this.kind = kind;
  }
}

/**
 * Fetch a file's bytes.
 *
 * @param {object} deps
 * @param {object} deps.telegram        a Telegraf telegram client
 * @param {Function} [deps.fetchImpl]   seam for tests; defaults to global fetch
 * @param {string} fileId
 * @param {{maxBytes:number, timeoutMs?:number}} limits
 * @returns {Promise<Buffer>}
 */
async function downloadTelegramFile({ telegram, fetchImpl = fetch }, fileId, {
  maxBytes, timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!telegram || typeof telegram.getFileLink !== 'function') {
    throw new TelegramDownloadError('no Telegram client', { kind: 'no_client' });
  }
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new TelegramDownloadError('no size limit was given', { kind: 'bad_limit' });
  }

  let url;
  try {
    url = String(await telegram.getFileLink(fileId));
  } catch (err) {
    // `err.message` here can be a Telegram API error that quotes the request —
    // only the error's NAME crosses this line.
    throw new TelegramDownloadError(
      `Telegram would not give a link for this file (${err?.name || 'error'})`,
      { kind: 'no_link' },
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  let response;
  try {
    response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Wenze/1.0' },
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = err?.name === 'AbortError';
    throw new TelegramDownloadError(
      aborted ? `the download did not finish within ${Math.round(timeoutMs / 1000)}s` : 'the download failed',
      { kind: aborted ? 'timeout' : 'network' },
    );
  }

  try {
    if (!response.ok) {
      // The status is safe; the URL that produced it is not.
      throw new TelegramDownloadError(
        `Telegram answered ${response.status} for this file`,
        { kind: 'http_error' },
      );
    }

    // The declared length, when there is one, ends it before a byte is read.
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      controller.abort();
      throw new TelegramDownloadError('the file is larger than the limit', { kind: 'too_large' });
    }

    const buffer = await readCapped(response, maxBytes, controller);
    return buffer;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the body, counting as it goes, and abort the moment it is too big.
 *
 * `arrayBuffer()` would buffer the whole thing first and only then let us
 * measure it, which is the opposite of a cap. When the body cannot be streamed
 * — a stubbed response in a test, an old runtime — the fallback measures after
 * the fact and still refuses, so the limit holds either way.
 */
async function readCapped(response, maxBytes, controller) {
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    const whole = Buffer.from(await response.arrayBuffer());
    if (whole.length > maxBytes) {
      throw new TelegramDownloadError('the file is larger than the limit', { kind: 'too_large' });
    }
    return whole;
  }

  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      controller.abort();
      await reader.cancel().catch(() => {});
      throw new TelegramDownloadError('the file is larger than the limit', { kind: 'too_large' });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

module.exports = { downloadTelegramFile, TelegramDownloadError, DEFAULT_TIMEOUT_MS };
