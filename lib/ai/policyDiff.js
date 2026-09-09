/**
 * Did the deal change, or did the page just re-render? PURE.
 *
 * This is the gate. Everything downstream of it — an AI reading, a finding, a
 * Telegram alert, a provider suspension — happens only for a diff that got
 * past here, so its two failure modes have opposite costs and both are real:
 *
 *   TOO SENSITIVE and the watcher alerts on every check. An alert that fires
 *   every time is one nobody reads, which leaves Wenze worse off than with no
 *   watcher, because now there is a green light nobody trusts.
 *
 *   TOO BLUNT and a provider quietly starts training on submitted driver
 *   messages and nothing says so. That is the failure this feature exists to
 *   prevent.
 *
 * The resolution is not a cleverer threshold, it is asking two different
 * questions and requiring both: HOW MUCH changed, and WHERE. A single sentence
 * added under "we may use your submissions to improve our models" outranks four
 * paragraphs of rewritten support-contact boilerplate, and a size-only rule
 * gets that exactly backwards.
 *
 * The diff itself is line-level and deliberately simple. A character-level diff
 * would be more precise about WHERE a word moved and no better at all at
 * deciding WHETHER it mattered, and the passages it produced would be too small
 * to read on their own — which matters, because those passages are the only
 * thing ever sent to a model.
 */
const { topicsIn } = require('./policyText');

/** Below this many changed characters, with no watched topic, is churn. */
const MATERIAL_CHARS = 120;
/** Never send more than this to a model, however large the diff. */
const MAX_PASSAGE_CHARS = 6000;

/**
 * Line-level diff, returning the passages that appeared and disappeared.
 *
 * A line present on both sides is unchanged wherever it moved to: a policy page
 * that reorders its sections has not changed its terms, and treating a move as
 * a change would make every restructure look like a rewrite.
 */
function diffLines(beforeText, afterText) {
  const before = String(beforeText || '').split('\n').filter(Boolean);
  const after = String(afterText || '').split('\n').filter(Boolean);

  const beforeCounts = new Map();
  for (const line of before) beforeCounts.set(line, (beforeCounts.get(line) || 0) + 1);
  const afterCounts = new Map();
  for (const line of after) afterCounts.set(line, (afterCounts.get(line) || 0) + 1);

  const added = [];
  for (const line of after) {
    const remaining = beforeCounts.get(line) || 0;
    if (remaining > 0) beforeCounts.set(line, remaining - 1);
    else added.push(line);
  }
  const removed = [];
  for (const line of before) {
    const remaining = afterCounts.get(line) || 0;
    if (remaining > 0) afterCounts.set(line, remaining - 1);
    else removed.push(line);
  }
  return { added, removed };
}

/**
 * Compare two normalised snapshots and decide whether anybody should be told.
 *
 * @returns {{
 *   changed: boolean, material: boolean, reason: string,
 *   added: string[], removed: string[], changedChars: number,
 *   topics: string[], passages: string
 * }}
 */
function comparePolicyText(beforeText, afterText) {
  const before = String(beforeText || '');
  const after = String(afterText || '');

  if (!before) {
    // First sight of a page is a baseline, never an alert. Alerting here would
    // fire once for every provider the moment the watcher is switched on, which
    // teaches an operator to ignore it on day one.
    return {
      changed: false, material: false, reason: 'first snapshot — recorded as the baseline',
      added: [], removed: [], changedChars: 0, topics: [], passages: '',
    };
  }
  if (before === after) {
    return {
      changed: false, material: false, reason: 'identical after normalisation',
      added: [], removed: [], changedChars: 0, topics: [], passages: '',
    };
  }

  const { added, removed } = diffLines(before, after);
  if (!added.length && !removed.length) {
    // Same lines, different order. Not a change to the terms.
    return {
      changed: false, material: false, reason: 'the same text, reordered',
      added: [], removed: [], changedChars: 0, topics: [], passages: '',
    };
  }

  const changedChars = [...added, ...removed].reduce((sum, line) => sum + line.length, 0);
  const topics = [...new Set([...topicsIn(added.join('\n')), ...topicsIn(removed.join('\n'))])];

  // WHERE outranks HOW MUCH. One sentence under a watched topic is material;
  // a page of reworded contact details is not.
  let material;
  let reason;
  if (topics.length > 0) {
    material = true;
    reason = `touches ${topics.join(', ')}`;
  } else if (changedChars >= MATERIAL_CHARS) {
    material = true;
    reason = `${changedChars} characters changed outside any watched topic`;
  } else {
    material = false;
    reason = `only ${changedChars} characters changed, in no watched section`;
  }

  return {
    changed: true,
    material,
    reason,
    added,
    removed,
    changedChars,
    topics,
    passages: buildPassages({ added, removed }),
  };
}

/**
 * The changed passages alone, labelled, capped.
 *
 * THIS IS THE ONLY THING EVER SENT TO A MODEL. Never the whole document: a
 * terms page is tens of thousands of characters, a model reading one twice a
 * week for every provider is the expensive workload this design exists to
 * avoid, and the model does not need the unchanged parts to say what the
 * changed parts mean.
 *
 * EVERY changed line is kept, with no minimum length. An earlier version
 * dropped lines under 40 characters as "fragments", and it silently amputated
 * half of a real change: replacing "You may use the API for commercial
 * purposes." (44 chars) with "The API is for non-commercial use only."
 * (39 chars) quoted only the REMOVED half, so the model — and the operator
 * reading the alert — saw a permission withdrawn and no idea what replaced it.
 * A one-character difference in line length decided which half of the sentence
 * survived, which is not a rule anything should depend on. Size is bounded by
 * the cap below; noise is already handled by normalisation, which strips chrome
 * before this ever runs.
 */
function buildPassages({ added = [], removed = [] } = {}) {
  const parts = [];
  if (added.length) parts.push(`ADDED:\n${added.join('\n')}`);
  if (removed.length) parts.push(`REMOVED:\n${removed.join('\n')}`);
  const joined = parts.join('\n\n');
  return joined.length > MAX_PASSAGE_CHARS
    ? `${joined.slice(0, MAX_PASSAGE_CHARS)}\n…[truncated]`
    : joined;
}

module.exports = {
  MATERIAL_CHARS,
  MAX_PASSAGE_CHARS,
  diffLines,
  comparePolicyText,
  buildPassages,
};
