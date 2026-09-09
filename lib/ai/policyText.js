/**
 * Turning a provider's terms page into text that only changes when the TERMS
 * change. PURE — no I/O, no state.
 *
 * This module is the entire cost control for the policy watcher, and the reason
 * it can run twice a week against every provider without becoming an AI
 * workload. The pipeline is:
 *
 *     conditional GET → 304? done → normalise → hash → unchanged? done
 *         → diff → immaterial? record, no alert → ONLY THEN a model
 *
 * A model is reached only for a diff that deterministic logic has already
 * proved is real. Everything before that point is string handling.
 *
 * WHAT NORMALISATION HAS TO REMOVE is the interesting part, and it is all
 * learned from what these pages actually do. A terms page re-rendered on every
 * request differs from the last one by: a copyright year, a "Last updated"
 * line, a build hash in an asset URL, a CSRF token, a session id, a cookie
 * banner, and whitespace. None of that is a change to the deal. If any of it
 * survives into the hash, the watcher cries wolf on every single check — and an
 * alert that fires every time is one nobody reads, which is worse than no
 * watcher at all.
 *
 * The opposite mistake is worse still: normalising so hard that a real change
 * disappears. So this strips only categories that CANNOT carry meaning, and
 * never touches sentence content. When in doubt it keeps the text and lets the
 * diff decide.
 */

/** Elements whose content is never part of the terms. */
const DROP_ELEMENTS = /<(script|style|noscript|svg|iframe|template)\b[^>]*>[\s\S]*?<\/\1>/gi;
/** Structural chrome — the same on every page of the site. */
const DROP_SECTIONS = /<(nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi;

/** Block-level tags become a newline so paragraph boundaries survive. */
const BLOCK_TAGS = /<\/?(p|div|br|li|tr|h[1-6]|section|article|ul|ol|table|blockquote)\b[^>]*>/gi;

const ENTITIES = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&apos;': "'", '&mdash;': '—', '&ndash;': '–', '&hellip;': '…',
};

/**
 * Volatile patterns, replaced with a stable token rather than deleted.
 *
 * Replaced and not removed so that a line which ONLY held a date does not
 * vanish and shift every following line in the diff — a deletion there would
 * look like a structural change when nothing moved.
 */
const VOLATILE = [
  // "Last updated: 4 March 2026", "Effective Date — 2026-03-04", "Revised 3/4/26"
  [/\b(last\s+(?:updated|modified|revised)|effective(?:\s+date)?|revised|updated)\b\s*[:\-–—]?\s*[^\n]{0,40}/gi, '«date»'],
  // Bare dates in any of the three common shapes.
  [/\b\d{4}-\d{2}-\d{2}\b/g, '«date»'],
  [/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, '«date»'],
  [/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b/gi, '«date»'],
  // "© 2026 Provider, Inc." — the year moves every January.
  [/(©|\(c\)|copyright)\s*\d{4}(\s*[-–]\s*\d{4})?/gi, '«copyright»'],
  // Build hashes, cache-busting query strings, nonces, ids.
  [/\b[0-9a-f]{16,64}\b/gi, '«hash»'],
  [/[?&](v|ver|version|build|cb|_|t|ts)=[^\s"'&]+/gi, '«cachebust»'],
  [/\b(csrf|nonce|session|request[-_]?id)["'\s:=]+[A-Za-z0-9_\-]{8,}/gi, '«token»'],
];

/** Boilerplate lines that appear on every page and say nothing about terms. */
const CHROME_LINE = new RegExp([
  '^(accept|reject|manage)\\s+(all\\s+)?cookies?\\b',
  '^we use cookies\\b',
  '^skip to (main )?content\\b',
  '^(sign|log)\\s?(in|up)\\b',
  '^(back to top|print this page|share this page)\\b',
  '^«(date|copyright|hash|cachebust|token)»$',
].join('|'), 'i');

function decodeEntities(text) {
  let out = text;
  for (const [entity, char] of Object.entries(ENTITIES)) {
    out = out.split(entity).join(char);
  }
  return out.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

/**
 * HTML (or plain text) → the comparable text of the policy.
 *
 * Idempotent: normalising already-normalised text returns it unchanged, which
 * matters because a stored snapshot is re-compared on every run.
 */
function normalisePolicyText(raw) {
  let text = String(raw || '');

  text = text.replace(DROP_ELEMENTS, ' ').replace(DROP_SECTIONS, ' ');
  text = text.replace(BLOCK_TAGS, '\n');
  text = text.replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text);

  for (const [pattern, token] of VOLATILE) text = text.replace(pattern, token);

  const lines = text
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .filter((line) => !CHROME_LINE.test(line));

  // Collapse repeated identical adjacent lines — a rendering artefact, not a
  // statement made twice.
  const collapsed = [];
  for (const line of lines) {
    if (collapsed[collapsed.length - 1] !== line) collapsed.push(line);
  }
  return collapsed.join('\n');
}

/**
 * The sections a change actually matters in, and the words that identify them.
 *
 * Used to decide whether a real diff is worth a person's attention. A change to
 * a support email address is a change; a change to whether submissions train
 * the model is the reason this watcher exists.
 */
const WATCHED_TOPICS = [
  {
    key: 'commercial_use',
    label: 'Commercial or production use',
    patterns: [/commercial(ly)?\s+(use|purpose)/i, /production\s+use/i, /business\s+use/i,
      /non[-\s]?commercial/i, /internal\s+use\s+only/i],
  },
  {
    key: 'trains_on_data',
    label: 'Whether submitted data trains the model',
    patterns: [/train(ing|ed)?\s+(our|the|its)?\s*models?/i, /improve\s+(our|the)\s+(models?|services)/i,
      /human\s+review/i, /may\s+be\s+used\s+to\s+train/i, /opt[-\s]?out/i],
  },
  {
    key: 'free_tier',
    label: 'Free-tier limits and conditions',
    patterns: [/free\s+(tier|plan|quota|usage)/i, /rate\s+limits?/i, /requests?\s+per\s+(day|minute)/i,
      /no\s+cost/i, /trial/i],
  },
  {
    key: 'retention',
    label: 'How long data is kept',
    patterns: [/retain(ed|s|ing)?/i, /retention/i, /delete[ds]?\s+(after|within)/i, /stored?\s+for/i],
  },
  {
    key: 'discontinuation',
    label: 'Deprecation or shutdown',
    patterns: [/deprecat(e|ed|ion)/i, /discontinu(e|ed|ing|ation)/i, /sunset/i,
      /end[-\s]of[-\s]life/i, /no longer (be )?(available|supported)/i],
  },
  {
    key: 'geography',
    label: 'Where the service may be used',
    patterns: [/geographic/i, /not available in/i, /restricted (countries|regions)/i,
      /export control/i, /sanction/i],
  },
];

/** Which watched topics a passage touches. */
function topicsIn(text) {
  const found = [];
  for (const topic of WATCHED_TOPICS) {
    if (topic.patterns.some((re) => re.test(text))) found.push(topic.key);
  }
  return found;
}

module.exports = {
  normalisePolicyText,
  topicsIn,
  WATCHED_TOPICS,
  CHROME_LINE,
  VOLATILE,
};
