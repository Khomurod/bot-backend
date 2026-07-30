/**
 * SOS scoring — deterministic scoring, tie-breaks, validation, and name
 * normalization. Uses a synthetic content stub so the tests are independent
 * of the real question text.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const CONTENT_PATH = path.resolve(__dirname, '../services/sosAssessment/content/index.js');
const SCORING_PATH = path.resolve(__dirname, '../services/sosAssessment/scoring.js');

function syntheticQuestions() {
  // Three questions; option pattern layout crafted so tests can force ties.
  const mk = (qk, patterns) => ({
    key: qk,
    text: { uz: 'u', ru: 'r', en: 'e' },
    options: patterns.map((pattern, i) => ({
      key: `${qk}_${'abcde'[i]}`,
      pattern,
      ...(pattern === 'builder' && qk === 'test_q03' ? { weight: 2 } : {}),
      text: { uz: 'u', ru: 'r', en: 'e' },
    })),
  });
  return [
    mk('test_q01', ['victim', 'complaint', 'waiting', 'blame', 'ownership']),
    mk('test_q02', ['blame', 'ownership', 'builder', 'victim', 'waiting']),
    mk('test_q03', ['ownership', 'builder', 'complaint', 'waiting', 'blame']),
  ];
}

function loadScoring() {
  for (const key of Object.keys(require.cache)) {
    if (key.includes(path.join('services', 'sosAssessment'))) delete require.cache[key];
  }
  require.cache[CONTENT_PATH] = {
    id: CONTENT_PATH,
    filename: CONTENT_PATH,
    loaded: true,
    exports: {
      getQuestions: (dept) => (dept === 'test' ? syntheticQuestions() : null),
    },
  };
  return require(SCORING_PATH);
}

test('scoring sums one weighted point per answer into the option pattern', () => {
  const { scoreAnswers } = loadScoring();
  const result = scoreAnswers('test', [
    { questionKey: 'test_q01', optionKey: 'test_q01_e' }, // ownership
    { questionKey: 'test_q02', optionKey: 'test_q02_b' }, // ownership
    { questionKey: 'test_q03', optionKey: 'test_q03_b' }, // builder, weight 2
  ]);
  assert.deepEqual(result.scores, { victim: 0, complaint: 0, waiting: 0, blame: 0, ownership: 2, builder: 2 });
  assert.equal(result.primary, 'ownership'); // tie: ownership precedes builder
  assert.equal(result.secondary, 'builder');
  assert.equal(result.answerSnapshots.length, 3);
  assert.deepEqual(result.answerSnapshots[2], {
    questionKey: 'test_q03', optionKey: 'test_q03_b', pattern: 'builder', weight: 2, position: 3,
  });
});

test('same answers always produce an identical result (determinism)', () => {
  const { scoreAnswers } = loadScoring();
  const answers = [
    { questionKey: 'test_q01', optionKey: 'test_q01_a' },
    { questionKey: 'test_q02', optionKey: 'test_q02_d' },
    { questionKey: 'test_q03', optionKey: 'test_q03_c' },
  ];
  const first = scoreAnswers('test', answers);
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(scoreAnswers('test', [...answers].reverse()), first);
  }
});

test('answer order within the payload does not affect the result', () => {
  const { scoreAnswers } = loadScoring();
  const answers = [
    { questionKey: 'test_q01', optionKey: 'test_q01_b' },
    { questionKey: 'test_q02', optionKey: 'test_q02_e' },
    { questionKey: 'test_q03', optionKey: 'test_q03_e' },
  ];
  const shuffled = [answers[2], answers[0], answers[1]];
  assert.deepEqual(scoreAnswers('test', shuffled), scoreAnswers('test', answers));
});

test('ties between negative patterns resolve by fixed precedence, not input order', () => {
  const { scoreAnswers } = loadScoring();
  // victim (q01) + blame (q02) + complaint (q03) → three-way tie at 1.
  const result = scoreAnswers('test', [
    { questionKey: 'test_q01', optionKey: 'test_q01_a' }, // victim
    { questionKey: 'test_q02', optionKey: 'test_q02_a' }, // blame
    { questionKey: 'test_q03', optionKey: 'test_q03_c' }, // complaint
  ]);
  // precedence: waiting > complaint > blame > victim among the tied set
  assert.equal(result.primary, 'complaint');
  assert.equal(result.secondary, 'blame');
});

test('secondary is null when every other pattern scored zero', () => {
  const { scoreAnswers } = loadScoring();
  const result = scoreAnswers('test', [
    { questionKey: 'test_q01', optionKey: 'test_q01_e' },
    { questionKey: 'test_q02', optionKey: 'test_q02_b' },
    { questionKey: 'test_q03', optionKey: 'test_q03_a' },
  ]);
  assert.equal(result.primary, 'ownership');
  assert.equal(result.secondary, null);
});

test('invalid submissions are rejected with typed errors', () => {
  const { scoreAnswers, SosValidationError } = loadScoring();
  const good = [
    { questionKey: 'test_q01', optionKey: 'test_q01_a' },
    { questionKey: 'test_q02', optionKey: 'test_q02_a' },
    { questionKey: 'test_q03', optionKey: 'test_q03_a' },
  ];
  assert.throws(() => scoreAnswers('nope', good), (e) => e instanceof SosValidationError && e.code === 'UNKNOWN_DEPARTMENT');
  assert.throws(() => scoreAnswers('test', good.slice(0, 2)), (e) => e.code === 'ANSWER_COUNT');
  assert.throws(() => scoreAnswers('test', [good[0], good[0], good[2]]), (e) => e.code === 'DUPLICATE_ANSWER');
  assert.throws(
    () => scoreAnswers('test', [good[0], good[1], { questionKey: 'test_q03', optionKey: 'test_q01_a' }]),
    (e) => e.code === 'UNKNOWN_OPTION',
  );
  assert.throws(
    () => scoreAnswers('test', [good[0], good[1], { questionKey: 'test_q99', optionKey: 'x' }]),
    (e) => e.code === 'MISSING_ANSWER',
  );
  assert.throws(() => scoreAnswers('test', [good[0], good[1], { questionKey: 'test_q03' }]), (e) => e.code === 'ANSWER_SHAPE');
});

test('name normalization unifies case, spacing, punctuation and Uzbek apostrophes', () => {
  const { normalizeName } = loadScoring();
  assert.equal(normalizeName('  Oʻtkir   GʻULOMOV '), normalizeName("O'tkir G'ulomov"));
  assert.equal(normalizeName('O’tkir G‘ulomov'), normalizeName("o'tkir g'ulomov"));
  assert.equal(normalizeName('Aziz-Bek Karimov.'), normalizeName('aziz bek karimov'));
  // NFKD folds ё→е and й→и, so common Cyrillic spelling variants match too.
  assert.equal(normalizeName('Ёркин Худойбердиев'), normalizeName('Еркин Худоибердиев'));
  assert.notEqual(normalizeName('Aziz Karimov'), normalizeName('Anvar Karimov'));
  assert.equal(normalizeName(null), '');
});
