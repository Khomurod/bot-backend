/**
 * The only things that may take a provider out of rotation on their own. PURE.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: an AI model never disables a provider
 * because of what it thinks a change means. A model may read the changed
 * passages and describe them; only an ENUMERATED, deterministic rule matching
 * the provider's own words may suspend.
 *
 * That is not caution for its own sake. A model asked "is this serious?" will
 * sometimes say yes about a clarified indemnity clause, and the cost of it
 * being wrong is that Wenze's AI features degrade for everyone until somebody
 * notices — for a change that never mattered. The cost of a rule being narrow
 * is an alert a human reads. Those are not symmetric, so the design is not
 * symmetric either.
 *
 * FOUR TRIGGERS, and each is a sentence a provider actually writes when it
 * means it. Each requires BOTH a change under the matching topic AND the
 * specific phrasing — a page that merely mentions commercial use is not a page
 * that just forbade it.
 *
 * A suspension is a COOLDOWN WITH A REASON, never `enabled = false`. It is
 * announced with the quoted passage and the source URL, and one admin click
 * reverses it. Nothing here is permanent, and nothing here is silent.
 */

const RULES = [
  {
    key: 'commercial_use_withdrawn',
    label: 'Commercial or production use is no longer permitted',
    topic: 'commercial_use',
    severity: 'serious',
    // "for non-commercial use only", "may not be used for commercial purposes",
    // "personal use only", "not licensed for production"
    patterns: [
      /non[-\s]?commercial\s+use\s+only/i,
      /(may|must)\s+not\s+be\s+used\s+for\s+commercial/i,
      /(prohibit|forbidden|not permitted)[^.]{0,40}commercial/i,
      /personal\s+use\s+only/i,
      /not\s+(licen[cs]ed|permitted)\s+for\s+production/i,
    ],
  },
  {
    key: 'trains_on_submitted_data',
    label: 'Submitted data will be used to train models',
    topic: 'trains_on_data',
    severity: 'serious',
    patterns: [
      /(will|may|do)\s+use\s+your\s+(data|content|submissions|prompts|inputs)[^.]{0,60}train/i,
      /your\s+(data|content|prompts)[^.]{0,40}(used\s+to\s+train|training\s+data)/i,
      /submissions?\s+(are|may be)\s+used\s+to\s+(train|improve)\s+(our|the)\s+models?/i,
    ],
    /**
     * Only suspends when free-only mode is on.
     *
     * The reasoning is Wenze's own posture: free tiers were chosen with
     * "minimised prompts" as the trade-off. If an operator is paying, training
     * terms are usually already excluded and the operator has made that call
     * deliberately — overriding it from a regex would be presumptuous.
     */
    onlyWhenFreeOnly: true,
  },
  {
    key: 'discontinued',
    label: 'The service or model is being discontinued',
    topic: 'discontinuation',
    severity: 'serious',
    patterns: [
      /will\s+be\s+(discontinued|shut\s?down|retired|sunset)/i,
      /no\s+longer\s+be\s+(available|supported|offered)/i,
      /end[-\s]of[-\s]life/i,
      /service\s+will\s+(close|end)\s+on/i,
    ],
  },
  {
    key: 'region_excluded',
    label: 'The service is no longer available in this region',
    topic: 'geography',
    severity: 'serious',
    patterns: [
      /not\s+available\s+in\s+the\s+(united\s+states|us|usa)/i,
      /(unavailable|restricted|prohibited)[^.]{0,30}(united\s+states|north\s+america)/i,
    ],
  },
];

/**
 * Should this change suspend the provider?
 *
 * Takes the DETERMINISTIC diff result — the topics the rules matched and the
 * passages that changed — and nothing a model produced. The signature has no
 * place to pass an AI verdict, which is deliberate: a function that cannot
 * receive an opinion cannot act on one.
 *
 * @param {object} args
 * @param {string[]} args.topics    from lib/ai/policyDiff
 * @param {string} args.passages    the changed text, and only the changed text
 * @param {boolean} [args.freeOnlyMode]
 * @param {boolean} [args.autoSuspendEnabled=false]
 * @returns {{suspend: boolean, rule: string|null, label: string|null,
 *            severity: string, matched: string|null, reason: string}}
 */
function evaluateSuspension({
  topics = [], passages = '', freeOnlyMode = true, autoSuspendEnabled = false,
} = {}) {
  const text = String(passages || '');

  for (const rule of RULES) {
    if (!topics.includes(rule.topic)) continue;
    if (rule.onlyWhenFreeOnly && !freeOnlyMode) continue;
    const matched = rule.patterns.map((re) => text.match(re)).find(Boolean);
    if (!matched) continue;

    // The rule fired. Whether it is ALLOWED to act is a separate, later
    // question — so an operator who turns auto-suspend off still learns that a
    // trigger matched, and still gets the severity that comes with it.
    return {
      suspend: autoSuspendEnabled === true,
      rule: rule.key,
      label: rule.label,
      severity: rule.severity,
      matched: matched[0].slice(0, 300),
      reason: autoSuspendEnabled === true
        ? `${rule.label} — the provider's own wording matched a suspension rule.`
        : `${rule.label} — matched a suspension rule, but automatic suspension is turned off.`,
    };
  }

  return {
    suspend: false, rule: null, label: null, severity: 'warning', matched: null,
    reason: 'No suspension rule matched; this is for a person to read.',
  };
}

module.exports = { RULES, evaluateSuspension };
