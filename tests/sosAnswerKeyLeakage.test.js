/**
 * SOS anti-gaming guards — the answer key must not be recoverable from the
 * SHAPE of the options, only from the meaning the respondent actually chooses.
 *
 * tests/sosContent.test.js proves the payload never ships `pattern`/`weight`.
 * This file guards the softer leak that broke the first content version: an
 * employee who wants to look good does not need the scoring key if every
 * ownership option is the one that says "myself", every builder option is the
 * longest, and every victim option opens with "I would tell my lead".
 *
 * Three families of guard:
 *   1. LEXICAL — a phrase used often inside one department must not belong to a
 *      single pattern, so no phrase works as a reusable tell.
 *   2. STRUCTURAL — length must not identify the constructive options, and
 *      victim/waiting must not be reliably the shortest.
 *   3. TONE — no option may sound self-pitying, careless or embarrassing; all
 *      five have to be choosable by a competent employee.
 *
 * What these guards deliberately do NOT try to hide: builder options genuinely
 * install a mechanism and ownership options genuinely close the case. That is
 * the pattern, not a tell — it is neutralised by making all five options
 * defensible (and by builder sometimes costing the immediate case), not by
 * scrubbing vocabulary.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const content = require('../services/sosAssessment/content');
const { DEPARTMENT_KEYS, LANGUAGES } = require('../services/sosAssessment/constants');

/** Every option of a department, flattened, per language. */
function options(dept) {
  return content.getQuestions(dept).flatMap((q) => q.options);
}

// ─────────────────────────── 1. lexical guards ───────────────────────────

// Phrases that used to work as a one-word answer key. Each entry is checked per
// department per language: if it appears in >= 4 options it must span >= 2
// patterns, and at >= 7 occurrences >= 3 patterns. Below 4 hits a phrase is too
// rare inside a 10-question department to be learnable.
const MARKERS = {
  uz: ['oʻzim', 'hoziroq', 'bugun', 'kutaman', 'tuzatish', 'oʻsha yerda', 'yoʻlga qoʻyaman',
    'taklif qilaman', 'lekin rahbarga aytaman', 'Rahbarga aniq aytaman', 'aytib qoʻyaman',
    'ajratib koʻr', 'hisobga olinishi kerak', 'baholanmasligi kerak', 'qaytadi', 'oʻzgarmasa'],
  ru: ['сам', 'прямо сейчас', 'сегодня', 'подожду', 'дождусь', 'исправлять надо', 'налажу',
    'предложу', 'но скажу руководителю', 'прямо скажу руководителю', 'не стоит считать',
    'разделять', 'повторится'],
  en: ['myself', 'right now', 'today', 'wait', 'establish', 'correction', 'set up', 'propose',
    'but tell my', 'not a measure', 'not be read as', 'separated', 'that is where it gets fixed'],
};

test('no phrase inside a department works as a reusable answer-key tell', () => {
  for (const dept of DEPARTMENT_KEYS) {
    for (const lang of LANGUAGES) {
      for (const marker of MARKERS[lang]) {
        const hits = options(dept).filter((o) => o.text[lang].toLowerCase().includes(marker.toLowerCase()));
        const patterns = new Set(hits.map((o) => o.pattern));
        const required = hits.length >= 7 ? 3 : (hits.length >= 4 ? 2 : 0);
        if (!required) continue;
        assert.ok(patterns.size >= required,
          `${dept} ${lang}: "${marker}" appears ${hits.length}x but only under ${[...patterns].join('/')} — needs >= ${required} patterns`);
      }
    }
  }
});

test('the constructive patterns are not the only ones that name a rule or a next step', () => {
  // Process language ("rule", "procedure", "order/schedule") must be reachable
  // from complaint/blame/waiting too — otherwise "the option that mentions a
  // rule" is the answer key.
  const PROCESS = { uz: ['tartib', 'qoida'], ru: ['порядок', 'правил', 'регламент'], en: ['procedure', 'rule', 'order', 'routine'] };
  for (const dept of DEPARTMENT_KEYS) {
    for (const lang of LANGUAGES) {
      const patterns = new Set();
      for (const o of options(dept)) {
        if (PROCESS[lang].some((w) => o.text[lang].toLowerCase().includes(w))) patterns.add(o.pattern);
      }
      // >= 2 is the floor that catches a single-pattern monopoly. Ratchet upward as
      // more options are reworded (see docs note in HANDOVER-SOS.md).
      assert.ok(patterns.size >= 2, `${dept} ${lang}: process language only in ${[...patterns].join('/')}`);
    }
  }
});

// ─────────────────────────── 2. structural guards ───────────────────────────

function countExtremes(dept, lang, pick) {
  const counts = {};
  for (const q of content.getQuestions(dept)) {
    const lengths = q.options.map((o) => o.text[lang].length);
    const target = pick(lengths);
    const winner = q.options[lengths.indexOf(target)].pattern;
    counts[winner] = (counts[winner] || 0) + 1;
  }
  return counts;
}

const longest = (l) => Math.max(...l);
const shortest = (l) => Math.min(...l);

test('length does not identify the desirable options', () => {
  for (const dept of DEPARTMENT_KEYS) {
    for (const lang of LANGUAGES) {
      const counts = countExtremes(dept, lang, longest);
      const own = counts.ownership || 0;
      const builder = counts.builder || 0;
      assert.ok(own <= 4, `${dept} ${lang}: ownership is the longest option in ${own}/10 questions`);
      assert.ok(builder <= 4, `${dept} ${lang}: builder is the longest option in ${builder}/10 questions`);
      assert.ok(own + builder <= 7,
        `${dept} ${lang}: ownership+builder are the longest in ${own + builder}/10 questions`);
      assert.ok(Object.keys(counts).length >= 3,
        `${dept} ${lang}: only ${Object.keys(counts).join('/')} ever hold the longest option`);
    }
  }
});

test('the less accountable options are not reliably the shortest', () => {
  for (const dept of DEPARTMENT_KEYS) {
    for (const lang of LANGUAGES) {
      const counts = countExtremes(dept, lang, shortest);
      for (const pattern of ['victim', 'waiting']) {
        assert.ok((counts[pattern] || 0) <= 5,
          `${dept} ${lang}: ${pattern} is the shortest option in ${counts[pattern]}/10 questions`);
      }
      assert.ok(Object.keys(counts).length >= 3,
        `${dept} ${lang}: only ${Object.keys(counts).join('/')} ever hold the shortest option`);
    }
  }
});

test('every option is a concrete first move, not a bare sentiment', () => {
  // A minimum body forces a real decision into every option: a one-clause
  // grumble would be instantly recognisable as the one to avoid.
  for (const dept of DEPARTMENT_KEYS) {
    for (const o of options(dept)) {
      for (const lang of LANGUAGES) {
        assert.ok(o.text[lang].trim().length >= 90, `${o.key} ${lang}: too short to be a real option`);
      }
    }
  }
});

// ─────────────────────────── 3. tone guards ───────────────────────────

// Self-pity, contempt and "I cannot be bothered" wording. Version 1 of the
// content leaked the key mainly through these: the option describing a FEELING
// about oneself was never the one management wanted, so it could be eliminated
// on sight. All six patterns must now be expressed as decisions.
const BANNED_TONE = {
  uz: ['alam qiladi', 'charchayman', 'ranjiyman', 'norozi boʻlaman', 'xafa boʻlaman',
    'adolatsiz', 'nima uchundir', 'nega aynan men', 'bekor ketadi', 'maʼnosi yoʻq'],
  ru: ['обидно', 'устаёшь', 'неприятно', 'возмущусь', 'несправедлив', 'почему именно',
    'впустую', 'крайними оказались', 'нервов'],
  en: ['it stings', 'grumble', 'exhausting', 'feel hurt', 'unfair', 'why me', 'wasted',
    'fall guys', 'galling', 'wears you down', 'i do not care'],
};

test('no option sounds self-pitying, contemptuous or careless', () => {
  for (const dept of DEPARTMENT_KEYS) {
    for (const o of options(dept)) {
      for (const lang of LANGUAGES) {
        const text = o.text[lang].toLowerCase();
        for (const phrase of BANNED_TONE[lang]) {
          assert.ok(!text.includes(phrase), `${o.key} ${lang}: banned tone "${phrase}"`);
        }
      }
    }
  }
});

test('safety-critical questions keep the control in every single option', () => {
  // Hiding the answer key must never cost an operational invariant: on these
  // four questions all five options have to keep the unsafe unit or the hold in
  // place. Written as a per-question whitelist so a future reword cannot
  // quietly introduce a "just send it" option.
  const GUARDED = {
    safety_q08: ['hold', 'holds'],                       // safety hold vs a hot load
    trailer_q04: ['out of service'],                     // door + marker light defect
    trailer_q07: ['hold', 'holds', 'keep the trailer', 'parked', 'before release'],
    trailer_q09: ['not let him continue', 'stop the driver', 'park', 'tire check', 'safe'],
  };
  for (const [questionKey, allowed] of Object.entries(GUARDED)) {
    const dept = questionKey.split('_')[0];
    const question = content.getQuestion(dept, questionKey);
    assert.ok(question, `missing ${questionKey}`);
    for (const o of question.options) {
      const text = o.text.en.toLowerCase();
      assert.ok(allowed.some((phrase) => text.includes(phrase)),
        `${o.key}: no evidence the control is preserved — "${o.text.en}"`);
    }
  }
});

test('content version was bumped past the pre-anti-gaming wording', () => {
  // v1 wording and v2 wording score the same keys but read completely
  // differently; a page held open across the deploy must be rejected, not
  // silently scored. See services/sosAssessment/content/index.js.
  assert.ok(content.CONTENT_VERSION >= 2, 'CONTENT_VERSION must be >= 2 after the rewrite');
});
