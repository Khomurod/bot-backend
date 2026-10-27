'use strict';

/**
 * Settings → Facebook ↔ Bitrix: the rules, with no I/O. What an input must look
 * like, what a Meta error means in plain words, and when a Test counts as
 * passed. services/metaCrm/settingsTest.js and settingsService.js do the I/O.
 */

/**
 * The four outcomes a check reports. WARN is "this could not be confirmed, and
 * here is why" — it never blocks Save. It exists because Meta answers the same
 * way for a wrong dataset ID and for a dataset with no events in 48 hours, and
 * a new dataset must still be savable.
 */
const CHECK = Object.freeze({ PASS: 'pass', WARN: 'warn', FAIL: 'fail', NOT_RUN: 'not_run' });

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
  const sub = Number(subcode);
  if (sub === 2804036) return 'Meta does not recognise that lead ID (it is unknown or the lead was deleted), so it refused the event.';
  if (sub === 2804004) return 'Meta refused the event\'s time: it must be within the last seven days.';
  if (c === 190) return 'Meta does not accept this access token — it is mistyped, expired or was revoked. Generate a new one in Events Manager → the dataset → Settings → Conversions API.';
  if (c === 100 || c === 803) return 'The token works, but it cannot see a dataset with this ID. Check the number, and generate the token from this same dataset\'s settings.';
  if (c === 10 || c === 200 || (c >= 200 && c <= 299)) return 'The token is missing a permission for this dataset. Generate the token from the dataset\'s own Conversions API settings, which grants it.';
  if ([4, 17, 32, 613, 80004].includes(c) || Number(status) === 429) return 'Meta is limiting requests right now. Wait a few minutes and test again.';
  if (Number(subcode) === 463 || Number(subcode) === 467) return 'The token has expired. Generate a new one.';
  if (Number(status) >= 500) return 'Meta had a problem of its own. Test again in a few minutes.';
  return 'Meta refused the request. Its own message is below.';
}

/**
 * Check a, from Meta's two answers: is the token alive (GET /me), and can it
 * see this dataset (Dataset Quality API). Learned against Meta with the owner's
 * token, 27 October 2026:
 *
 *   /me fails                     → FAIL: the token itself is refused.
 *   dataset quality 200           → PASS.
 *   dataset quality code 24       → WARN: Meta says the same for an ID this
 *                                   token cannot see AND for a dataset with no
 *                                   events in 48 hours, so it cannot be told
 *                                   apart — a new dataset must still save.
 *   a permission refusal          → WARN: a token made WITHOUT the Dataset
 *                                   Quality API option cannot read quality,
 *                                   yet can still send.
 *   timeout / Meta down / other   → FAIL: nothing was confirmed.
 *
 * Returns `{ status, message }`; the caller adds Meta's own words.
 */
function judgeTokenAndDataset({ owner, quality, datasetId }) {
  if (!owner?.ok) {
    return { status: CHECK.FAIL, message: owner?.timedOut ? 'Meta did not answer in time. Test again in a minute.' : explainGraphError(owner) };
  }
  if (quality?.ok) {
    return { status: CHECK.PASS, message: `Meta accepts the token, and it can see dataset ${datasetId}.` };
  }
  const code = Number(quality?.code);
  if (code === 24) {
    return {
      status: CHECK.WARN,
      message: `Meta accepts the token, but could not confirm dataset ${datasetId}: either the ID is not this token's dataset, or the dataset has had no events in the last 48 hours (normal for a new one). Make sure the ID matches Events Manager exactly — you can still save.`,
    };
  }
  // 100 is also "invalid parameter", so only its permission form counts here.
  const permission = code === 10 || (code >= 200 && code <= 299)
    || (code === 100 && /permission/i.test(String(quality?.error || '')));
  if (permission) {
    return {
      status: CHECK.WARN,
      message: 'Meta accepts the token, but this token was made without the "Dataset Quality API" option, so the dataset cannot be checked from here. Sending still works if the token was generated for this dataset — you can save, or generate the token again with that option.',
    };
  }
  return { status: CHECK.FAIL, message: quality?.timedOut ? 'Meta did not answer in time. Test again in a minute.' : explainGraphError(quality) };
}

/**
 * Whether a Test result allows Save: the token-and-dataset check passed (or
 * warned) and nothing else that ran failed. "Not run" is not a failure — a
 * test without a test event code skips that check on purpose.
 */
function testPassed(checks) {
  const list = Array.isArray(checks) ? checks : [];
  const token = list.find((c) => c.key === 'token');
  return Boolean(token && (token.status === CHECK.PASS || token.status === CHECK.WARN))
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
  judgeTokenAndDataset,
  testPassed,
};
