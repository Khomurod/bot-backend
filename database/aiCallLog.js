/**
 * What each AI call cost and whether it worked. No prompts, no completions.
 *
 * The absence of content is the design, not an omission. Provider, model,
 * latency and outcome answer every operational question worth asking — is this
 * provider healthy, which model actually answered, has the free tier run out —
 * and none of them require keeping a single word a driver wrote. A log that
 * held prompts would be a second copy of driver conversations sitting in a
 * table nobody remembers to protect.
 *
 * This also makes `chat_message_annotations.model_version` honest for the first
 * time: it has stored the constant string 'groq-v1-annotator' since the column
 * was created, rather than whichever model actually answered.
 *
 * Writes here NEVER throw into the caller. Failing an AI call because its
 * telemetry could not be written would be exactly backwards.
 */
const { query } = require('./pool');

/**
 * Record one attempt.
 *
 * @param {object} entry
 * @param {string} [entry.capabilityKey]
 * @param {string} [entry.providerKey]
 * @param {string} [entry.model]
 * @param {'ok'|'failed'|'skipped'} entry.outcome
 * @param {string} [entry.failureKind]  a FAILURE.* from lib/ai/classify
 * @param {number} [entry.latencyMs]
 * @param {number} [entry.attempts]
 * @param {string} [entry.errorMessage]  truncated; never a prompt
 */
async function recordAiCall(entry = {}) {
  try {
    await query(
      `INSERT INTO ai_call_log
         (capability_key, provider_key, model, outcome, failure_kind,
          latency_ms, prompt_tokens, completion_tokens, attempts, error_message)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        entry.capabilityKey ?? null,
        entry.providerKey ?? null,
        entry.model ?? null,
        entry.outcome || 'failed',
        entry.failureKind ?? null,
        Number.isFinite(entry.latencyMs) ? Math.round(entry.latencyMs) : null,
        Number.isFinite(entry.promptTokens) ? entry.promptTokens : null,
        Number.isFinite(entry.completionTokens) ? entry.completionTokens : null,
        Number.isFinite(entry.attempts) ? entry.attempts : 1,
        entry.errorMessage ? String(entry.errorMessage).slice(0, 500) : null,
      ]
    );
  } catch (err) {
    // Telemetry must never be the reason a feature fails.
    console.warn('[AI LOG] Could not record a call:', err.message);
  }
}

/**
 * Per-provider health over a window, zero-filled per provider.
 *
 * Split by failure CLASS rather than a single success rate, because "out of
 * quota" and "the key is dead" need different responses from an operator and
 * averaging them into one percentage hides which one is happening.
 */
async function summariseProviderHealth({ sinceHours = 24 } = {}) {
  try {
    const res = await query(
      `SELECT provider_key,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE outcome = 'ok')::int AS ok,
              COUNT(*) FILTER (WHERE outcome = 'failed')::int AS failed,
              COUNT(*) FILTER (WHERE failure_kind = 'quota')::int AS quota,
              COUNT(*) FILTER (WHERE failure_kind = 'credential')::int AS credential,
              COUNT(*) FILTER (WHERE failure_kind = 'transient')::int AS transient,
              ROUND(AVG(latency_ms) FILTER (WHERE outcome = 'ok'))::int AS avg_latency_ms
         FROM ai_call_log
        WHERE created_at >= NOW() - ($1 || ' hours')::interval
          AND provider_key IS NOT NULL
        GROUP BY provider_key`,
      [String(Math.max(1, Number(sinceHours) || 24))]
    );
    return res.rows.map((r) => ({
      providerKey: r.provider_key,
      total: r.total,
      ok: r.ok,
      failed: r.failed,
      quota: r.quota,
      credential: r.credential,
      transient: r.transient,
      avgLatencyMs: r.avg_latency_ms,
      successPct: r.total ? Math.round((r.ok / r.total) * 1000) / 10 : null,
    }));
  } catch (err) {
    // The admin page degrades to "no data yet" rather than to an error card —
    // the VideoRecoveryCard rule.
    console.warn('[AI LOG] Could not summarise health:', err.message);
    return [];
  }
}

/** The most recent failures, for the "what went wrong" panel. */
async function listRecentFailures({ limit = 20 } = {}) {
  try {
    const res = await query(
      `SELECT provider_key, model, capability_key, failure_kind, error_message, created_at
         FROM ai_call_log
        WHERE outcome = 'failed'
        ORDER BY created_at DESC
        LIMIT $1`,
      [Math.min(100, Math.max(1, Number(limit) || 20))]
    );
    return res.rows.map((r) => ({
      providerKey: r.provider_key,
      model: r.model,
      capabilityKey: r.capability_key,
      failureKind: r.failure_kind,
      errorMessage: r.error_message,
      createdAt: r.created_at,
    }));
  } catch (err) {
    console.warn('[AI LOG] Could not list failures:', err.message);
    return [];
  }
}

/** Retention. Operational exhaust with no reason to be immortal. */
async function pruneAiCallLog(retentionDays = 30) {
  const days = Math.min(365, Math.max(1, Number(retentionDays) || 30));
  const res = await query(
    `DELETE FROM ai_call_log WHERE created_at < NOW() - ($1 || ' days')::interval`,
    [String(days)]
  );
  return res.rowCount || 0;
}

module.exports = {
  recordAiCall,
  summariseProviderHealth,
  listRecentFailures,
  pruneAiCallLog,
};
