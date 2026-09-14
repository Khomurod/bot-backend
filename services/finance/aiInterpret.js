'use strict';

/**
 * Asking a model what a finance message MEANS — the fallback, never the path.
 *
 * WHEN THIS RUNS. Only when the deterministic parser saw finance words and
 * could not settle them: `unparsed` or `ambiguous`. A message the rules read
 * cleanly never reaches a model, which keeps the common case free, fast and
 * offline.
 *
 * WHAT IT MAY CONTRIBUTE. A KIND — issuing, voiding, asking, or unrelated — and
 * a pointer to a code that is already in the text. It does not decide which
 * code a void refers to; that stays with `lib/finance/void/target.js`, which
 * weighs reply relationships and refuses to guess between two candidates. The
 * model widens what can be understood; it never widens what may be concluded.
 *
 * WHY EVERY NUMBER COMES BACK THROUGH A VERIFIER. A model asked to read a
 * half-legible payment message will, sooner or later, produce a plausible
 * ten-digit code that was never there — and a plausible code in a finance table
 * is a payment record for money nobody sent. `lib/finance/aiReading.js` looks
 * for every digit in the captured text and drops what it cannot find. That is
 * enforcement; the prompt below is only a request.
 *
 * WITH NO PROVIDER AT ALL, NOTHING CHANGES. `AiUnavailableError` and every
 * other failure return "unclear", the message keeps the status the rules gave
 * it, and the Finance Monitor goes on working exactly as it does today.
 */

const { verifyAiReading, KINDS } = require('../../lib/finance/aiReading');

const CAPABILITY = 'finance_message_reading';

/** Only these two are worth a model's time; the rest are already settled. */
const UNSETTLED = Object.freeze(['unparsed', 'ambiguous']);

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    isCapabilityEnabled: require('../ai/capabilityGate').isCapabilityEnabled,
    runCapability: require('../ai/router').runCapability,
  };
  /* eslint-enable global-require */
}

/**
 * The prompt. The message is fenced as untrusted data because it is: anybody
 * who can post in the finance group can write "ignore the above" into it.
 */
function buildPrompt(text) {
  return 'You are reading one message from a trucking company\'s finance group chat.\n'
    + 'Say what the message is DOING. Do not invent any number: every digit you report '
    + 'must appear in the message exactly as written, and if it does not, leave the field null.\n\n'
    + `Answer with JSON only: { "kind": one of ${KINDS.join(' | ')}, `
    + '"code": the money/EFS code as written or null, '
    + '"amount": the amount as a number or null, '
    + '"reportReference": a reference number as written or null, '
    + '"issuedTo": the recipient exactly as written or null, '
    + '"referencesCode": for a void or replacement, the code it refers to as written, or null, '
    + '"confidence": 0-100, "evidence": a short quote from the message }\n\n'
    + '"kind" meanings: issue = this message issues a code; void_completed = it reports that a '
    + 'code HAS BEEN voided; void_request = it asks for one to be voided, or asks whether to; '
    + 'replacement = it says one code replaces another; unrelated = ordinary conversation; '
    + 'unclear = you cannot tell.\n\n'
    + '<finance_message>\n' + String(text || '') + '\n</finance_message>';
}

/** A shape check before the content check — a wrong shape is not a reading. */
function validateShape(raw) {
  const value = typeof raw === 'string' ? safeJson(raw) : raw;
  if (!value || typeof value !== 'object') return { message: 'not an object' };
  if (!KINDS.includes(String(value.kind))) return { message: 'kind is not one of the allowed values' };
  return true;
}

function safeJson(text) {
  try {
    return JSON.parse(String(text).replace(/^```(?:json)?/i, '').replace(/```$/, '').trim());
  } catch (_) {
    return null;
  }
}

/**
 * Read one message with a model, and keep only what the message supports.
 *
 * @returns `{ used, reading, reason }` — `used: false` whenever the rules
 *   already settled it, the capability is off, no provider answered, or the
 *   reading was refused. Never throws.
 */
async function interpretMessage({ text, status }, deps = defaultDeps()) {
  if (!UNSETTLED.includes(String(status))) {
    return { used: false, reading: null, reason: 'the rules already settled this message' };
  }
  const source = String(text || '').trim();
  if (!source) return { used: false, reading: null, reason: 'no text to read' };

  try {
    if (!(await deps.isCapabilityEnabled(CAPABILITY))) {
      return { used: false, reading: null, reason: 'the capability is switched off' };
    }
    const answer = await deps.runCapability({
      capability: CAPABILITY,
      userText: buildPrompt(source),
      expects: 'json',
      maxOutputTokens: 300,
      temperature: 0,
      validate: validateShape,
    });

    const raw = answer?.json ?? (typeof answer?.text === 'string' ? safeJson(answer.text) : answer);
    const verified = verifyAiReading(raw, source);
    if (!verified.ok) {
      return { used: false, reading: verified, reason: verified.reason };
    }
    return { used: true, reading: verified, reason: verified.reason };
  } catch (err) {
    // No provider, every provider refusing, a timeout — all the same answer.
    return { used: false, reading: null, reason: `no reading available (${err.message})` };
  }
}

module.exports = { CAPABILITY, UNSETTLED, buildPrompt, validateShape, interpretMessage };
