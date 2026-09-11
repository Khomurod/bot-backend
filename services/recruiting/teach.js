/**
 * Teaching Wenze something, in ordinary language.
 *
 * An administrator types a sentence — "starting today, company driver pay is
 * 77 CPM instead of 70" — and Wenze says back what it believes that means and
 * what it would change. NOTHING takes effect until a person agrees.
 *
 * THE CONFIRMATION IS NOT A FORMALITY. This is the only path by which a fact
 * reaches a candidate, and a candidate quoted a wrong rate is a real problem
 * for a real person. So the reading is shown in full, the exact words typed are
 * what gets stored, and the model's job ends at "here is what I think you
 * mean".
 *
 * With no AI at all this still works. The deterministic reading classifies the
 * sentence and picks a topic; the administrator sees a plainer restatement and
 * confirms it exactly as they would otherwise. A model makes the restatement
 * better and finds the entry being replaced; it is never load-bearing.
 */
const CAPABILITY = 'recruiting_knowledge_reading';

/** Words that make a sentence a prohibition rather than a fact. */
const BOUNDARY_HINTS = [
  /\bnever\b/i, /\bdo not\b/i, /\bdon't\b/i, /\bmust not\b/i,
  /\bavoid\b/i, /\bstop (?:saying|telling)\b/i, /\bno longer (?:say|tell|offer)\b/i,
];

/** A rough topic, so the list stays readable before anyone organises it. */
const TOPIC_HINTS = [
  [/\bcpm\b|\bcents? per mile\b|\bpay\b|\bsalary\b|\brate\b|\bbonus\b/i, 'pay'],
  [/\borientation\b|\bonboard/i, 'orientation'],
  [/\bhome ?time\b|\bdays? off\b|\bpto\b/i, 'home time'],
  [/\bsap\b|\bbackground\b|\bmvr\b|\bdui\b|\brecord\b|\bexperience\b|\bcdl\b/i, 'hiring requirements'],
  [/\btruck\b|\btrailer\b|\bequipment\b|\bapu\b|\bgovern/i, 'equipment'],
  [/\binsurance\b|\bbenefit\b|\bmedical\b|\bdental\b|\b401/i, 'benefits'],
  [/\blane\b|\bregion\b|\bstate\b|\botr\b|\bdedicated\b/i, 'lanes'],
];

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    store: require('../../database/recruitingKnowledge'),
    runCapability: require('../ai/router').runCapability,
    isCapabilityEnabled: require('../ai/capabilityGate').isCapabilityEnabled,
  };
  /* eslint-enable global-require */
}

/** The reading that needs no model. Always available, always the fallback. */
function readDeterministically(statement) {
  const text = String(statement || '').trim();
  const kind = BOUNDARY_HINTS.some((r) => r.test(text)) ? 'boundary' : 'fact';
  const topic = (TOPIC_HINTS.find(([r]) => r.test(text)) || [null, 'general'])[1];
  const understoodAs = kind === 'boundary'
    ? `Wenze will not say this to candidates: ${text}`
    : `Wenze may tell candidates: ${text}`;
  return { kind, topic, understoodAs, replaces: null, aiAssisted: false };
}

function buildPrompt({ statement, active }) {
  const existing = active.length
    ? active.map((k) => `  [${k.id}] (${k.kind}/${k.topic}) ${k.statement}`).join('\n')
    : '  (nothing yet)';
  return [
    'A trucking company administrator is teaching a recruiting assistant something.',
    'Read their sentence and report what it means. You are NOT applying it — a person will confirm.',
    '',
    'Their sentence:',
    statement,
    '',
    'What the assistant already knows:',
    existing,
    '',
    'Answer with JSON only:',
    '{',
    '  "kind": "fact" | "boundary",',
    '  "topic": "a short lowercase noun phrase, e.g. pay, orientation, hiring requirements",',
    '  "understood_as": "one plain sentence restating what the assistant will now do or not do",',
    '  "replaces_id": <the id above this clearly replaces, or null>',
    '}',
    '',
    'Rules:',
    '- "fact" is something to TELL candidates. "boundary" is something never to say.',
    '- replaces_id ONLY when the sentence plainly updates that exact entry. When unsure, null.',
    '- Do NOT restate anything the sentence does not say. Add no numbers, no conditions.',
    '- understood_as must be understandable to someone who has not read the sentence.',
  ].join('\n');
}

function validateReading(parsed) {
  if (!parsed || typeof parsed !== 'object') return { message: 'not an object' };
  if (!['fact', 'boundary'].includes(parsed.kind)) return { message: 'kind must be fact or boundary' };
  if (typeof parsed.understood_as !== 'string' || parsed.understood_as.trim().length < 12) {
    return { message: 'understood_as must be a sentence' };
  }
  return true;
}

/**
 * What Wenze thinks the sentence means. Shown for confirmation; changes nothing.
 *
 * @returns {Promise<{kind, topic, understoodAs, replaces, aiAssisted}>}
 */
async function readStatement(statement, deps = defaultDeps()) {
  const fallback = readDeterministically(statement);
  try {
    if (!(await deps.isCapabilityEnabled(CAPABILITY))) return fallback;
    const active = await deps.store.listActiveKnowledge().catch(() => []);
    const { parsed } = await deps.runCapability({
      capability: CAPABILITY,
      userText: buildPrompt({ statement: String(statement || '').trim(), active }),
      expects: 'json',
      validate: validateReading,
    });
    if (validateReading(parsed) !== true) return fallback;

    // A claimed replacement is only honoured when it names something that
    // actually exists and is actually active. A model naming a plausible id
    // would otherwise retire a fact nobody meant to touch.
    const replacesId = Number(parsed.replaces_id);
    const replaces = Number.isInteger(replacesId)
      ? active.find((k) => Number(k.id) === replacesId) || null
      : null;

    return {
      kind: parsed.kind,
      topic: String(parsed.topic || fallback.topic).trim().slice(0, 60) || fallback.topic,
      understoodAs: String(parsed.understood_as).trim().slice(0, 500),
      replaces,
      aiAssisted: true,
    };
  } catch (_) {
    return fallback;
  }
}

/**
 * Read the sentence and record it as a proposal.
 *
 * The statement stored is the administrator's OWN WORDS, never the model's
 * rewording. That is what a person confirmed and what a dispute would be judged
 * against; a paraphrase in its place would quietly become the record.
 */
async function proposeFromStatement(statement, { proposedBy = null } = {}, deps = defaultDeps()) {
  const text = String(statement || '').trim();
  if (text.length < 8) throw new Error('Say a little more than that.');
  const reading = await readStatement(text, deps);
  const row = await deps.store.proposeKnowledge({
    kind: reading.kind,
    topic: reading.topic,
    statement: text,
    understoodAs: reading.understoodAs,
    supersedesId: reading.replaces?.id ?? null,
    proposedBy,
  });
  return { proposal: row, reading, replaces: reading.replaces || null };
}

/**
 * The knowledge, written for a prompt.
 *
 * Boundaries come after facts and corrections after both, because a model
 * attends most to what it read last and the later ones are the ones that stop
 * it saying something wrong.
 */
function renderForPrompt(entries) {
  if (!entries?.length) return '';
  const section = (kind, heading) => {
    const rows = entries.filter((e) => e.kind === kind);
    if (!rows.length) return null;
    return [heading, ...rows.map((e) => `- ${e.statement}`)].join('\n');
  };
  return [
    section('fact', 'What you may tell a candidate:'),
    section('boundary', 'What you must NEVER say:'),
    section('correction', 'Corrections from previous mistakes — these override the above:'),
  ].filter(Boolean).join('\n\n');
}

module.exports = {
  CAPABILITY,
  readDeterministically,
  buildPrompt,
  validateReading,
  readStatement,
  proposeFromStatement,
  renderForPrompt,
};
