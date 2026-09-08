'use strict';

/**
 * "Will a lead text actually leave from this recruiter's number?" — the PURE
 * decision behind the Diagnose button's number steps.
 *
 * This is the step that is supposed to predict a rejected send, and it used to
 * get it wrong in the one way that mattered: it compared the stored number and
 * RingCentral's numbers through a last-ten-digits key, so
 * `(470) 480-4679` vs `+14704804679` reported **"Number match: OK"** while every
 * real send was rejected with `MSG-245 … Cannot find the phone number which
 * belongs to user`. The admin panel was green and the feature was broken.
 *
 * A send now goes out as `toE164(phone_number)`, so this predicts THAT:
 *
 *   unsendable  the stored value is not a phone number at all — no send will
 *               ever be attempted, and leads fall back to the shared number.
 *   not_owned   RingCentral does not list this line on the token's extension.
 *   spelling    owned, but RingCentral spells it differently from what we would
 *               send. The send self-corrects, so this is a tidy-up, not an
 *               outage.
 *   ok          owned and spelled the same.
 *   unreadable  the extension's numbers could not be read (permission), so
 *               there is nothing to compare against.
 *
 * Extracted from diagnosticsRoutes.js so it can be tested without an HTTP
 * server or a RingCentral token (CLAUDE.md → separate pure decisions from I/O).
 */
const { toE164, phoneKey } = require('../../../lib/phone/e164');

/**
 * @param {object} params
 * @param {string} params.storedNumber              `recruiters.phone_number`
 * @param {string[]} [params.extensionPhoneNumbers] what RingCentral lists
 * @returns {{verdict:'unsendable'|'unreadable'|'not_owned'|'spelling'|'ok',
 *   ok:boolean, label:string, detail:string, sendable:string,
 *   canonical:string|null}}
 */
function diagnoseSenderNumber({ storedNumber, extensionPhoneNumbers = [] }) {
  const stored = String(storedNumber ?? '').trim();
  const sendable = toE164(stored);
  const owned = (Array.isArray(extensionPhoneNumbers) ? extensionPhoneNumbers : []).filter(Boolean);

  if (!sendable) {
    return {
      verdict: 'unsendable',
      ok: false,
      label: 'Sender number',
      detail: `"${stored}" is not a phone number a text can be sent from. Their leads will go out `
        + 'from the shared number until it is corrected — any format works '
        + '(e.g. (470) 480-4679, 4702400064, +14704804679).',
      sendable,
      canonical: null,
    };
  }

  if (!owned.length) {
    return {
      verdict: 'unreadable',
      ok: true,
      label: 'Number match',
      detail: 'Extension phone numbers not readable (permission not granted) — skipped.',
      sendable,
      canonical: null,
    };
  }

  const key = phoneKey(stored);
  const canonical = owned.find((number) => phoneKey(number) === key) || null;

  if (!canonical) {
    return {
      verdict: 'not_owned',
      ok: false,
      label: 'Number match',
      detail: `This login owns ${owned.join(', ')} — not ${stored}. Calls would be attributed to `
        + 'the wrong person and lead texts would be rejected.',
      sendable,
      canonical: null,
    };
  }

  if (toE164(canonical) !== sendable) {
    return {
      verdict: 'spelling',
      ok: false,
      label: 'Number match',
      detail: `RingCentral knows this line as ${canonical}, but the stored value reads as `
        + `${sendable}. The send is corrected automatically, so texts still go out from their own `
        + 'number — worth tidying the stored number so the two agree.',
      sendable,
      canonical,
    };
  }

  return {
    verdict: 'ok',
    ok: true,
    label: 'Number match',
    detail: sendable === stored
      ? `${stored} belongs to this RingCentral user.`
      : `${stored} belongs to this RingCentral user, and sends as ${sendable}.`,
    sendable,
    canonical,
  };
}

module.exports = { diagnoseSenderNumber };
