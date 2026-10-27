'use strict';

/**
 * Settings → Facebook ↔ Bitrix: the rules, with no I/O. What an input must look
 * like, what a Meta error means in plain words, and when a Test counts as
 * passed. services/metaCrm/settingsTest.js and settingsService.js do the I/O.
 */

/** pass / fail / not_run — the only three outcomes a check reports. */
const CHECK = Object.freeze({ PASS: 'pass', FAIL: 'fail', NOT_RUN: 'not_run' });

function invalid(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

/** A dataset id is digits only (Events Manager → the dataset → Settings). */
function normalizeDatasetId(value) {
  const text = String(value ?? '').trim();
  if (!text) throw invalid('Enter the dataset ID (Events Manager → your CRM dataset → Settings).');
  if (!/^\d{1,30}$/.test(text)) throw invalid('The dataset ID is digits only — copy the number from Events Manager → the dataset → Settings.');
  return text;
}

/**
 * A pasted token: non-empty, no whitespace anywhere. Returns '' for "nothing
 * typed" — the caller then keeps the stored token — and throws for a token
 * with a space or line break in it, which is a paste that went wrong.
 */
function normalizeToken(value) {
  if (value === undefined || value === null) return '';
  const text = String(value);
  if (!text.trim()) return '';
  if (/\s/.test(text.trim()) || text.trim().length < 20) {
    throw invalid('The access token looks wrong: paste it again in one piece, with no spaces or line breaks.');
  }
  return text.trim();
}

/** Events Manager's test code (e.g. TEST12345). Optional; '' means "not given". */
function normalizeTestEventCode(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (!/^[A-Za-z0-9_-]{2,64}$/.test(text)) throw invalid('The test event code is letters and digits only, e.g. TEST12345 (Events Manager → Test events).');
  return text;
}

/** `••••abcd` from a token or its stored last four characters. */
function maskLast4(last4) {
  const tail = String(last4 ?? '');
  return tail ? `••••${tail.slice(-4)}` : null;
}

const last4Of = (token) => String(token ?? '').slice(-4);

/**
 * What a Graph API error means for the person who typed the values. Meta's own
 * code and words are shown beside this, so nothing is hidden by the
 * translation.
 */
function explainGraphError({ code, subcode, status } = {}) {
  const c = Number(code);
  if (c === 190) return 'Meta does not accept this access token — it is mistyped, expired or was revoked. Generate a new one in Events Manager → the dataset → Settings → Conversions API.';
  if (c === 100 || c === 803) return 'The token works, but it cannot see a dataset with this ID. Check the number, and generate the token from this same dataset\'s settings.';
  if (c === 10 || c === 200 || (c >= 200 && c <= 299)) return 'The token is missing a permission for this dataset. Generate the token from the dataset\'s own Conversions API settings, which grants it.';
  if ([4, 17, 32, 613, 80004].includes(c) || Number(status) === 429) return 'Meta is limiting requests right now. Wait a few minutes and test again.';
  if (Number(subcode) === 463 || Number(subcode) === 467) return 'The token has expired. Generate a new one.';
  if (Number(status) >= 500) return 'Meta had a problem of its own. Test again in a few minutes.';
  return 'Meta refused the request. Its own message is below.';
}

/**
 * Whether a Test result allows Save: the token-and-dataset check passed and
 * nothing else that ran failed. "Not run" is not a failure — a test without a
 * test event code skips that check on purpose.
 */
function testPassed(checks) {
  const list = Array.isArray(checks) ? checks : [];
  const token = list.find((c) => c.key === 'token');
  return Boolean(token && token.status === CHECK.PASS)
    && list.every((c) => c.status !== CHECK.FAIL);
}

module.exports = {
  CHECK,
  invalid,
  normalizeDatasetId,
  normalizeToken,
  normalizeTestEventCode,
  maskLast4,
  last4Of,
  explainGraphError,
  testPassed,
};
