'use strict';

/**
 * Putting one Datatruck document into one Telegram group.
 *
 * Split out of services/datatruckDocumentService.js, which owns WHICH documents
 * go WHERE; this module owns only HOW a file gets there — and the bandwidth rule
 * below, which is the part most likely to be undone by a well-meaning edit.
 */
const config = require('../config/config');
const { Input } = require('telegraf');
const { bot } = require('../bot/bot');
const { safeSend, isPermanentSendError } = require('./telegramHtml');
const {
  isTrackedDocumentType,
  buildDocumentCaption,
  buildDocumentFilename,
  resolveDocumentUrl,
} = require('./datatruckDocumentHelpers');

const DOWNLOAD_TIMEOUT_MS = 60_000;

function authHeaders() {
  return { Authorization: `Token ${config.datatruckApiToken}` };
}

/**
 * Download a document's bytes for upload to Telegram (used only when Telegram
 * cannot fetch the URL itself). Tries unauthenticated first (Datatruck hands
 * back presigned links); retries with the API token if access is denied.
 */
async function downloadDocument(fileLink) {
  const maxBytes = config.datatruckDocMaxFileMb * 1024 * 1024;
  async function attempt(withAuth) {
    const res = await fetch(fileLink, {
      headers: withAuth ? authHeaders() : undefined,
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) {
      const err = new Error(`Document download failed: HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(`Document too large to forward (${declared} bytes).`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new Error(`Document too large to forward (${buffer.length} bytes).`);
    }
    return buffer;
  }
  try {
    return await attempt(false);
  } catch (err) {
    if ((err.status === 401 || err.status === 403) && config.datatruckApiToken) {
      return attempt(true);
    }
    throw err;
  }
}

/** Minimal caption/filename for an unclear document sent for human review. */
function buildReviewCaption(doc) {
  const load = doc?.loadReference || doc?.orderId;
  return `📄 Document needs review${load ? `\nLoad: ${load}` : ''}`;
}
function buildReviewFilename(doc) {
  const ref = String(doc?.loadReference || doc?.orderId || 'file').replace(/[^A-Za-z0-9._-]/g, '_');
  return `document_${ref}.pdf`;
}

/**
 * Send one document to a group.
 *
 * BANDWIDTH-CRITICAL — read before changing the send call.
 *
 * The happy path hands Telegram the URL as a PLAIN STRING, so TELEGRAM'S
 * SERVERS fetch the file from Datatruck. The document bytes never touch this
 * process, which is what keeps BOL/POD forwarding off the Render egress bill.
 * In Telegraf 4.x `Input.fromURL(url)` is literally `url.toString()`, and a
 * string payload is attached as an ordinary form field (see
 * telegraf/lib/core/network/client.js → attachFormValue).
 *
 * `Input.fromURLStream(url, filename)` looks like the same thing and is NOT:
 * it returns `{ url, filename }`, which makes Telegraf fetch the URL itself and
 * pipe the response through this process into a multipart upload — every byte
 * inbound AND outbound on Render. Do not swap it in. That also means
 * `fromURL` takes ONE argument: a filename passed here is silently ignored, so
 * Telegram names the file from the URL path on this route (the fallback below
 * does apply `filename`). Losing the pretty filename is the deliberate price
 * of not relaying the bytes.
 *
 * The fallback exists because Telegram cannot always fetch: a file over its
 * ~20MB URL limit, an expired presigned link, or a Datatruck URL that needs the
 * API token. Telegram reports those as a 400 that `isPermanentSendError` does
 * not classify as permanent, so we download (retrying WITH the API token on
 * 401/403) and upload the bytes ourselves. Delivery reliability wins there.
 *
 * In `review` mode (an unclear document forwarded to the central review group)
 * the tracked-type guard is relaxed and a generic caption/filename is used.
 */
async function sendDocumentToGroup(telegramGroupId, doc, { review = false } = {}) {
  if (!review && !isTrackedDocumentType(doc?.fileType)) {
    throw new Error(`Refusing to send unsupported document type: ${doc?.fileType || 'unknown'}`);
  }
  const caption = review ? buildReviewCaption(doc) : buildDocumentCaption(doc);
  const filename = review ? buildReviewFilename(doc) : buildDocumentFilename(doc);
  const fileUrl = resolveDocumentUrl(doc.fileLink, config.datatruckDocMediaBaseUrl);
  if (!fileUrl) throw new Error('Document has no resolvable file URL.');
  const extra = { caption, parse_mode: 'HTML' };
  try {
    // One argument on purpose — see the note above. Telegram fetches this URL.
    return await safeSend(() => bot.telegram.sendDocument(
      telegramGroupId,
      Input.fromURL(fileUrl),
      extra,
    ));
  } catch (err) {
    if (isPermanentSendError(err)) throw err;
    // Telegram could not fetch/serve the URL (over its ~20MB URL limit, an
    // expired presigned link, or one needing the Datatruck token) — relay the
    // bytes ourselves. `filename` DOES apply on this path.
    const buffer = await downloadDocument(fileUrl);
    return safeSend(() => bot.telegram.sendDocument(
      telegramGroupId,
      Input.fromBuffer(buffer, filename),
      extra,
    ));
  }
}

module.exports = { downloadDocument, sendDocumentToGroup };
