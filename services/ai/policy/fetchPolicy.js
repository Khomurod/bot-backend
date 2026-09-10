/**
 * Fetching one policy page as cheaply as it can be fetched.
 *
 * The conditional request is what makes this feature nearly free. A provider
 * that has not touched its terms answers **304 with no body**, and the check
 * ends there — no parsing, no diffing, and certainly no model. Across six
 * providers twice a week, that is the difference between a background job
 * nobody notices and one somebody eventually switches off.
 *
 * A fetch failure is NOT a finding. A terms page that is briefly unreachable
 * says nothing about the terms, and filing a finding for it would train an
 * operator to ignore the ones that matter. It is recorded on the snapshot as an
 * error with a failure count, and the admin shows it.
 */
const { normalisePolicyText } = require('../../../lib/ai/policyText');

const DEFAULT_TIMEOUT_MS = 20_000;
/** A terms page is prose. Anything this large is not one. */
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * @returns {Promise<{status: number, notModified: boolean, etag, lastModified,
 *   text: string|null, error: string|null}>}
 */
async function fetchPolicyPage({
  url, etag = null, lastModified = null, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch,
} = {}) {
  const headers = {
    // Named honestly. A watcher that disguises itself as a browser is one a
    // provider is entitled to block, and being blocked silently is the failure
    // mode that would make this feature quietly useless.
    'User-Agent': 'Wenze-PolicyWatcher/1.0 (+operational terms monitoring)',
    Accept: 'text/html,text/plain;q=0.9,*/*;q=0.8',
  };
  if (etag) headers['If-None-Match'] = etag;
  if (lastModified) headers['If-Modified-Since'] = lastModified;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { headers, signal: controller.signal, redirect: 'follow' });
    clearTimeout(timer);

    const nextEtag = response.headers?.get?.('etag') ?? null;
    const nextLastModified = response.headers?.get?.('last-modified') ?? null;
    // Where the request actually landed. Differs from `url` after a redirect,
    // which is how the watcher learns a page moved without a person telling it.
    const finalUrl = typeof response.url === 'string' && response.url ? response.url : url;

    if (response.status === 304) {
      return {
        status: 304, notModified: true, etag: nextEtag || etag,
        lastModified: nextLastModified || lastModified, text: null, error: null, finalUrl,
      };
    }
    if (!response.ok) {
      return {
        status: response.status, notModified: false, etag, lastModified, text: null,
        error: `HTTP ${response.status}`, finalUrl,
      };
    }

    const raw = await response.text();
    if (raw.length > MAX_BYTES) {
      return {
        status: response.status, notModified: false, etag: nextEtag, lastModified: nextLastModified,
        text: null, error: `Response too large (${raw.length} bytes)`, finalUrl,
      };
    }
    return {
      status: response.status,
      notModified: false,
      etag: nextEtag,
      lastModified: nextLastModified,
      text: normalisePolicyText(raw),
      error: null,
      finalUrl,
    };
  } catch (err) {
    clearTimeout(timer);
    const reason = err.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : err.message;
    return { status: null, notModified: false, etag, lastModified, text: null, error: reason, finalUrl: url };
  }
}

module.exports = { fetchPolicyPage, DEFAULT_TIMEOUT_MS, MAX_BYTES };
