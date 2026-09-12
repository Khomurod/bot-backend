'use strict';

/**
 * Talking to the Dispatcher Board, carefully.
 *
 * The Board is a Google Apps Script web app. Three things about that shape the
 * whole module:
 *
 * 1. IT AUTHENTICATES BY QUERY STRING. Nothing we can change, so the token is
 *    added at the last possible moment and no error, log line or return value
 *    ever carries a URL — every message leaves through `stripUrls`.
 *
 * 2. IT REDIRECTS. An Apps Script `/exec` answers 302 to
 *    `script.googleusercontent.com`, so exactly ONE redirect is followed, by
 *    hand. `redirect: 'follow'` would work too, but it would also follow a
 *    chain to anywhere, and this request carries a credential: a Board whose
 *    script is edited to redirect elsewhere would hand the token away. One hop,
 *    and the token is NOT re-attached to it — the signed Google URL carries its
 *    own authorisation.
 *
 * 3. IT CAN RETURN ANYTHING. A misconfigured script answers 200 with an HTML
 *    login page. So the body is size-capped before it is read, the content is
 *    parsed as JSON defensively, and an HTML answer is reported as "not JSON"
 *    rather than thrown at the parser.
 *
 * Memory matters here: this runs on a 512 MB instance beside everything else,
 * and a runaway response is a restart. The cap is enforced while streaming, not
 * after buffering, because `await response.text()` on a huge body has already
 * spent the memory by the time you could check its length.
 */
const { stripUrls } = require('../../lib/security/redactUrls');

const REQUEST_TIMEOUT_MS = 15_000;
/** The Board is about a hundred rows of short strings; 2 MB is generous. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 1;

/** Everything this module throws. Its `message` is already URL-stripped. */
class BoardFetchError extends Error {
  constructor(message, { status = null, kind = 'fetch_failed' } = {}) {
    super(stripUrls(message));
    this.name = 'BoardFetchError';
    this.status = status;
    this.kind = kind;
  }
}

/** `base?token=…`, preserving any parameters the base URL already carries. */
function buildBoardUrl(baseUrl, token) {
  const url = new URL(String(baseUrl));
  if (token) url.searchParams.set('token', String(token));
  return url.toString();
}

/**
 * Read a response body without letting it get large.
 *
 * Returns the text, or throws when the cap is passed. `content-length` is
 * checked first when the server sends one, and the stream is measured as it
 * arrives when it does not — a server can lie or omit it.
 */
async function readCappedText(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new BoardFetchError(
      `the board answered with ${declared} bytes, over the ${maxBytes}-byte limit`,
      { status: response.status, kind: 'too_large' }
    );
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    // No stream (a test double, or an older runtime): fall back to text and
    // check afterwards. Still bounded by the declared length check above.
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) {
      throw new BoardFetchError(
        `the board answered with more than ${maxBytes} bytes`,
        { status: response.status, kind: 'too_large' }
      );
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch (_) { /* the socket is going anyway */ }
      throw new BoardFetchError(
        `the board answered with more than ${maxBytes} bytes`,
        { status: response.status, kind: 'too_large' }
      );
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

/**
 * Fetch the Board once.
 *
 * @param {{baseUrl: string, token: string}} connection
 * @param {{fetchImpl?: Function, timeoutMs?: number, maxBytes?: number}} [options]
 * @returns {Promise<{status: number, json: *}>}
 * @throws {BoardFetchError} always with a URL-free message
 */
async function fetchBoard({ baseUrl, token } = {}, {
  fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS, maxBytes = MAX_BODY_BYTES,
} = {}) {
  if (!baseUrl) throw new BoardFetchError('no board URL is saved', { kind: 'not_configured' });
  if (!token) throw new BoardFetchError('no board token is saved', { kind: 'not_configured' });

  let url;
  try {
    url = buildBoardUrl(baseUrl, token);
  } catch (_) {
    throw new BoardFetchError('the saved board URL is not a URL', { kind: 'bad_url' });
  }

  let response;
  let redirects = 0;
  for (;;) {
    try {
      // eslint-disable-next-line no-await-in-loop
      response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      throw new BoardFetchError(
        timedOut
          ? `the board did not answer within ${Math.round(timeoutMs / 1000)}s`
          : `the board could not be reached (${err?.cause?.code || err?.code || 'no answer'})`,
        { kind: timedOut ? 'timeout' : 'unreachable' }
      );
    }

    const location = response.status >= 300 && response.status < 400
      ? response.headers?.get?.('location')
      : null;
    if (!location) break;
    if (redirects >= MAX_REDIRECTS) {
      throw new BoardFetchError(
        'the board redirected more than once, which a credentialled request must not follow',
        { status: response.status, kind: 'too_many_redirects' }
      );
    }
    redirects += 1;
    // The signed Google URL carries its own authorisation; the token is NOT
    // re-attached, so a redirect can never carry it somewhere new.
    try {
      url = new URL(location, url).toString();
    } catch (_) {
      throw new BoardFetchError('the board redirected somewhere unreadable', { kind: 'bad_redirect' });
    }
  }

  if (!response.ok) {
    throw new BoardFetchError(
      `the board answered ${response.status}`,
      { status: response.status, kind: 'http_error' }
    );
  }

  const text = await readCappedText(response, maxBytes);
  try {
    return { status: response.status, json: JSON.parse(text) };
  } catch (_) {
    // An Apps Script that is not shared publicly answers 200 with a Google
    // sign-in page. Saying "not JSON" is the useful sentence; quoting the body
    // would put a login page in a log.
    throw new BoardFetchError(
      'the board answered with something that is not JSON — check that the web app is shared with anyone who has the link',
      { status: response.status, kind: 'not_json' }
    );
  }
}

module.exports = {
  fetchBoard,
  buildBoardUrl,
  BoardFetchError,
  REQUEST_TIMEOUT_MS,
  MAX_BODY_BYTES,
  MAX_REDIRECTS,
};
