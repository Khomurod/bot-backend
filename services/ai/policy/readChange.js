/**
 * Asking a model what a change means — the one AI call in this whole feature.
 *
 * It happens only for a diff `lib/ai/policyDiff.js` has already proved is
 * material, and it is given the CHANGED PASSAGES ALONE, never the document. A
 * model reading a full terms page twice a week for every provider is precisely
 * the workload this design exists to avoid.
 *
 * WHAT IT MAY AND MAY NOT DECIDE. It may write the plain-language summary, say
 * what changed and why that matters, and suggest a category. It may NOT
 * suspend a provider — that is `lib/ai/policySuspension.js`, deterministic and
 * enumerated, and this function's output never reaches it.
 *
 * AI FAILURE MUST NOT COST THE FINDING. If every provider is down, cooled, or
 * switched off, the finding is still written — from the deterministic evidence,
 * marked `aiAssisted: false`. A watcher that goes silent exactly when the AI
 * layer is unhealthy would be worst at the moment it is needed most.
 */
const { runCapability } = require('../router');
const { WATCHED_TOPICS } = require('../../../lib/ai/policyText');

const CAPABILITY = 'policy_reading';

const SYSTEM_TEXT = [
  'You read changes to an AI provider\'s terms of service and explain them plainly.',
  'You are given ONLY the passages that changed, already proven different by a diff.',
  'Answer as JSON: {"category": one of '
    + `${WATCHED_TOPICS.map((t) => `"${t.key}"`).join(', ')}, "other"`
    + ', "severity": "info"|"warning"|"serious", "summary": string,'
    + ' "whatChanged": string, "whyItMatters": string}',
  'Be concrete and short. Do not speculate beyond the passages you are shown.',
  'Do not recommend disabling anything — that decision is not yours to make.',
].join('\n');

/** A deterministic finding, written when no model answered. */
function fallbackReading({ topics = [], reason = '' }) {
  const label = topics.length
    ? topics.join(', ')
    : 'a section outside the watched topics';
  return {
    category: topics[0] || 'other',
    severity: topics.length ? 'warning' : 'info',
    summary: `The terms changed in ${label}.`,
    whatChanged: reason || 'A material difference was detected against the stored snapshot.',
    whyItMatters: 'Nobody has interpreted this yet — the passages below are the raw change.',
    aiAssisted: false,
    aiModel: null,
  };
}

const CATEGORIES = new Set([...WATCHED_TOPICS.map((t) => t.key), 'other']);
const SEVERITIES = new Set(['info', 'warning', 'serious']);

/**
 * @param {object} args
 * @param {string} args.passages   the changed text, and only the changed text
 * @param {string[]} args.topics   what the deterministic rules matched
 * @param {string} args.providerKey
 * @param {Function} [args.run]    injectable for tests
 */
async function readChange({ passages, topics = [], providerKey, reason = '', run = runCapability }) {
  try {
    const result = await run({
      capability: CAPABILITY,
      systemText: SYSTEM_TEXT,
      userText: `Provider: ${providerKey}\nWatched topics touched: ${topics.join(', ') || 'none'}\n\n${passages}`,
      expects: 'json',
      validate: (_text, parsed) => (
        parsed && typeof parsed.summary === 'string' && parsed.summary.trim()
          ? true
          : { message: 'no summary in the response' }
      ),
    });
    const parsed = result.parsed || {};
    return {
      // The model SUGGESTS a category and severity; both are clamped to the
      // enumerations rather than trusted, so an invented value cannot reach the
      // schema and turn a finding into a constraint violation.
      category: CATEGORIES.has(parsed.category) ? parsed.category : (topics[0] || 'other'),
      severity: SEVERITIES.has(parsed.severity) ? parsed.severity : 'warning',
      summary: String(parsed.summary).slice(0, 1000),
      whatChanged: parsed.whatChanged ? String(parsed.whatChanged).slice(0, 2000) : null,
      whyItMatters: parsed.whyItMatters ? String(parsed.whyItMatters).slice(0, 2000) : null,
      aiAssisted: true,
      aiModel: result.model || null,
    };
  } catch (err) {
    console.warn('[POLICY] No model could read the change; filing it deterministically:', err.message);
    return fallbackReading({ topics, reason });
  }
}

module.exports = { readChange, fallbackReading, CAPABILITY, SYSTEM_TEXT };
