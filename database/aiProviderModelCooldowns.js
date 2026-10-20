'use strict';

/**
 * Per-MODEL pauses: a model whose own allowance is spent is skipped until it
 * resets, while the rest of its provider's chain keeps answering.
 *
 * Groq and Gemini count free allowances per model, so a spent `openai/gpt-oss-20b`
 * says nothing about `openai/gpt-oss-120b`. The provider-wide cooldown in
 * `database/aiProviders.js` stays for what really is provider-wide — a dead
 * key, an account-wide daily allowance, spent credits.
 *
 * Stored in `ai_providers.model_cooldowns` (migration 0074) as
 * `{ "<model>": { "until": ISO, "reason": text } }`. Each write is a single
 * jsonb merge in SQL, so two workers pausing two models cannot lose either.
 */
const { query } = require('./pool');

/** Pause one model until `until` (a Date or ms), with a reason a person can read. */
async function pauseModel(providerKey, model, { until, reason }) {
  const at = new Date(until);
  if (!model || Number.isNaN(at.getTime())) return;
  await query(
    `UPDATE ai_providers
        SET model_cooldowns = COALESCE(model_cooldowns, '{}'::jsonb)
              || jsonb_build_object($2::text, jsonb_build_object('until', $3::text, 'reason', $4::text))
      WHERE provider_key = $1`,
    [providerKey, String(model), at.toISOString(), String(reason || '').slice(0, 300)]
  );
}

/** The model answered: whatever pause it had is over. A no-op when it had none. */
async function clearModelPause(providerKey, model) {
  await query(
    `UPDATE ai_providers
        SET model_cooldowns = model_cooldowns - $2::text
      WHERE provider_key = $1 AND model_cooldowns ? $2::text`,
    [providerKey, String(model)]
  );
}

/** An operator putting every model of a provider back in rotation. */
async function clearAllModelPauses(providerKey) {
  await query(
    `UPDATE ai_providers SET model_cooldowns = '{}'::jsonb WHERE provider_key = $1`,
    [providerKey]
  );
}

module.exports = { pauseModel, clearModelPause, clearAllModelPauses };
