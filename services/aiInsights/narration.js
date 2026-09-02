/**
 * WORDING the detected cards — the only AI call in AI Insights.
 *
 * One batched request narrates every card, so a report costs a single model
 * call rather than one per card. The findings themselves are already fixed by
 * the detectors: this layer may only phrase them, and a parse failure degrades
 * to the deterministic text rather than dropping the card.
 *
 * Split out of services/aiInsightsService.js, which re-exports
 * parseBatchCardNarratives for its unit tests.
 */
const { callGroqWithFallback } = require('../groqClient');

// ── Narrative generation (Consolidated Groq call for all cards) ──────────
const BATCH_SYSTEM_PROMPT = [
  'You are an executive auditor for a trucking company.',
  'I am providing evidence for several operational categories in a JSON object.',
  'Return a single, valid JSON object where the keys are the exact card IDs provided,',
  'and the values are an object containing keys: narrative_html, suggested_action, severity (1..3).',
  'The narrative_html should be a 1-2 sentence HTML-formatted narrative summarizing the evidence.',
  'Rules:',
  '- Ground every claim in the provided metrics or evidence excerpts.',
  '- Never fabricate facts. If evidence is thin, say "limited signal" explicitly.',
  '- Use plain HTML only: <b>, <i>, <br>. DO NOT output markdown blocks, only raw JSON.',
  '- Include at most 3 inline <a href="..."> links using only URLs present in input.evidence.',
  '- Never include code fences or prose outside the JSON.',
].join('\n');

function buildBatchCardPrompt(cardsContext) {
  return `Cards briefing input:\n${JSON.stringify(cardsContext, null, 2)}`;
}

function parseBatchCardNarratives(text) {
  if (!text) return {};
  const cleaned = String(text)
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === 'object') {
      const result = {};
      for (const [key, val] of Object.entries(parsed)) {
        if (val && typeof val === 'object') {
          result[key] = {
             narrative_html: typeof val.narrative_html === 'string'
               ? val.narrative_html.slice(0, 4000)
               : null,
             suggested_action: typeof val.suggested_action === 'string'
               ? val.suggested_action.slice(0, 500)
               : null,
             severity: Number.isFinite(Number(val.severity))
               ? Math.max(1, Math.min(3, Math.round(Number(val.severity))))
               : 1,
          };
        }
      }
      return result;
    }
  } catch (_) { /* fall through */ }
  return {};
}

async function narrateBatch(cardsContext) {
  if (Object.keys(cardsContext).length === 0) return {};
  try {
    const { text: raw } = await callGroqWithFallback(buildBatchCardPrompt(cardsContext), {
      systemText: BATCH_SYSTEM_PROMPT,
      temperature: 0.3,
      maxTokens: 3000,
    });
    return parseBatchCardNarratives(raw) || {};
  } catch (err) {
    console.error('[AI-INSIGHTS] Batch Narrative failed:', err.message);
    return {};
  }
}

module.exports = {
  BATCH_SYSTEM_PROMPT,
  buildBatchCardPrompt,
  parseBatchCardNarratives,
  narrateBatch,
};
