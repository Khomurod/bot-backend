'use strict';

/**
 * Groq's limits, as production actually received them (October 2026).
 *
 * Every Groq error ends with "Need more tokens? Upgrade to Dev Tier today at
 * https://console.groq.com/settings/billing", and `billing` is quota language.
 * So an oversized request for ONE model, or a per-MINUTE limit, was read as a
 * spent daily allowance, and all of Groq was cooled until the next UTC
 * midnight. On 19 and 20 October that happened just after midnight, and for
 * the rest of the day no AI feature had a provider: Safety Approvals gave up
 * on twenty Safety replies with "No AI provider was eligible".
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { FAILURE, classifyFailure, retryAfterMs } = require('../lib/ai/classify');
const { cooldownFor } = require('../lib/ai/cooldown');

const BILLING = ' Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing';
const TOO_LARGE = '429 Request too large for model `qwen/qwen3.8-27b` in organization `org_x` service tier '
  + '`on_demand` on output tokens per minute (OTPM): Limit 1000, Requested 1016. The request\'s expected '
  + 'output tokens exceed the enforced limit; reduce max_tokens (or the request\'s expected output) and try again.'
  + BILLING;
const TPM = '429 Rate limit reached for model `openai/gpt-oss-20b` in organization `org_x` service tier '
  + '`on_demand` on tokens per minute (TPM): Limit 8000, Used 7834, Requested 845. Please try again in 5.0925s.'
  + BILLING;
const TPD = '429 Rate limit reached for model `openai/gpt-oss-20b` in organization `org_x` service tier '
  + '`on_demand` on tokens per day (TPD): Limit 200000, Used 198251, Requested 3497. Please try again in 12m35.136s.'
  + BILLING;
const NOW = Date.parse('2026-10-19T00:04:19Z');

test('AN OVERSIZED REQUEST FOR ONE MODEL NEVER COOLS THE PROVIDER — the next model is asked', () => {
  const verdict = classifyFailure({ status: 429, message: TOO_LARGE });
  assert.equal(verdict.kind, FAILURE.FATAL_REQUEST);
  assert.equal(verdict.coolProvider, false, 'this is what took Groq offline until midnight');
  assert.equal(verdict.skipModel, true);
});

test('a per-minute limit is busy for seconds, not spent for the day', () => {
  const verdict = classifyFailure({ status: 429, message: TPM });
  assert.equal(verdict.kind, FAILURE.TRANSIENT);
  const cooled = cooldownFor({
    kind: verdict.kind, retryAfterMs: retryAfterMs({ message: TPM }), now: NOW,
  });
  assert.ok(cooled.until - NOW < 5 * 60 * 1000, `cooled ${(cooled.until - NOW) / 1000}s`);
});

test('a per-DAY limit is still quota, with the wait Groq stated', () => {
  assert.equal(classifyFailure({ status: 429, message: TPD }).kind, FAILURE.QUOTA);
  assert.equal(retryAfterMs({ message: TPD, maxMs: 3_600_000 }), 755_136, '"12m35.136s" is 12 minutes, not 12 seconds');
  assert.equal(
    classifyFailure({ status: 429, message: '429 Rate limit exceeded: free-models-per-day. Add 10 credits' }).kind,
    FAILURE.QUOTA,
    'OpenRouter\'s daily free allowance stays a daily wait'
  );
});

test('spent credits are still quota — the billing word is only ignored where the limit is per minute', () => {
  for (const message of [
    '402 Your prepayment credits are depleted. Please go to AI Studio to manage your project and billing.',
    '400 Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing.',
    'You exceeded your current quota, please check your plan and billing details.',
  ]) {
    assert.equal(classifyFailure({ status: 429, message }).kind, FAILURE.QUOTA, message);
  }
});
