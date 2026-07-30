/**
 * SOS content integrity — every department has exactly 10 questions × 5
 * options in all three languages, every option maps to a valid pattern,
 * ownership/builder appear in every question, negative patterns are balanced,
 * result blocks are complete, and the PUBLIC serializer leaks no scoring data.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const content = require('../services/sosAssessment/content');
const { PATTERNS, DEPARTMENT_KEYS, LANGUAGES } = require('../services/sosAssessment/constants');

test('validateContent reports no problems', () => {
  assert.deepEqual(content.validateContent(), []);
});

test('every department ships exactly 10 questions with 5 options and 3 languages', () => {
  for (const dept of DEPARTMENT_KEYS) {
    const questions = content.getQuestions(dept);
    assert.equal(questions.length, 10, dept);
    for (const q of questions) {
      assert.equal(q.options.length, 5, q.key);
      for (const lang of LANGUAGES) {
        assert.ok(q.text[lang].trim().length > 20, `${q.key} ${lang}`);
        for (const o of q.options) assert.ok(o.text[lang].trim().length > 10, `${o.key} ${lang}`);
      }
    }
  }
});

test('pattern usage is balanced: ownership/builder in every question, negatives 7-8 per department', () => {
  for (const dept of DEPARTMENT_KEYS) {
    const counts = {};
    for (const q of content.getQuestions(dept)) {
      const patterns = q.options.map((o) => o.pattern);
      assert.ok(patterns.includes('ownership'), `${q.key}: no ownership option`);
      assert.ok(patterns.includes('builder'), `${q.key}: no builder option`);
      for (const p of patterns) counts[p] = (counts[p] || 0) + 1;
    }
    assert.equal(counts.ownership, 10, dept);
    assert.equal(counts.builder, 10, dept);
    for (const p of ['victim', 'complaint', 'waiting', 'blame']) {
      assert.ok(counts[p] >= 7 && counts[p] <= 8, `${dept}: ${p} used ${counts[p]} times`);
    }
  }
});

test('the strongest options do not sit in a fixed position', () => {
  for (const dept of DEPARTMENT_KEYS) {
    const ownershipPositions = new Set();
    const builderPositions = new Set();
    for (const q of content.getQuestions(dept)) {
      q.options.forEach((o, i) => {
        if (o.pattern === 'ownership') ownershipPositions.add(i);
        if (o.pattern === 'builder') builderPositions.add(i);
      });
    }
    assert.ok(ownershipPositions.size >= 3, `${dept}: ownership always in ${[...ownershipPositions]}`);
    assert.ok(builderPositions.size >= 3, `${dept}: builder always in ${[...builderPositions]}`);
  }
});

test('option lengths within a question stay comparable (no giveaway by size)', () => {
  for (const dept of DEPARTMENT_KEYS) {
    for (const q of content.getQuestions(dept)) {
      for (const lang of LANGUAGES) {
        const lengths = q.options.map((o) => o.text[lang].length);
        const ratio = Math.max(...lengths) / Math.min(...lengths);
        assert.ok(ratio <= 2.6, `${q.key} ${lang}: length ratio ${ratio.toFixed(2)}`);
      }
    }
  }
});

test('question and option text never names the patterns or the method', () => {
  const forbidden = [/qbq/i, /\bsos\b/i, /savol ortidagi/i, /ownership/i, /builder/i,
    /виктим/i, /жертв/i, /личная ответственность/i, /victim/i, /shaxsiy mas/i];
  for (const dept of DEPARTMENT_KEYS) {
    for (const q of content.getQuestions(dept)) {
      const texts = [q.text.uz, q.text.ru, q.text.en,
        ...q.options.flatMap((o) => [o.text.uz, o.text.ru, o.text.en])];
      for (const t of texts) {
        for (const re of forbidden) assert.ok(!re.test(t), `${q.key}: "${t.slice(0, 60)}" matches ${re}`);
      }
    }
  }
});

test('the public questionnaire payload contains no pattern or weight data', () => {
  for (const dept of DEPARTMENT_KEYS) {
    const payload = content.toPublicQuestions(dept);
    assert.equal(payload.length, 10);
    const json = JSON.stringify(payload);
    assert.ok(!json.includes('"pattern"'), `${dept}: pattern leaked`);
    assert.ok(!json.includes('"weight"'), `${dept}: weight leaked`);
    for (const q of payload) {
      assert.deepEqual(Object.keys(q).sort(), ['key', 'options', 'position', 'text']);
      for (const o of q.options) assert.deepEqual(Object.keys(o).sort(), ['key', 'text']);
    }
  }
});

test('all six result blocks are complete and respectful in three languages', () => {
  for (const pattern of PATTERNS) {
    for (const lang of LANGUAGES) {
      const block = content.resultForLanguage(pattern, lang);
      assert.ok(block.name.length > 2);
      assert.ok(block.headline.length > 20);
      assert.ok(block.explanation.length > 100);
      assert.ok(block.strengths.length >= 2);
      assert.ok(block.risks.length >= 2);
      assert.ok(block.techniques.length >= 2 && block.techniques.length <= 3);
      assert.ok(block.sosQuestions.length >= 2 && block.sosQuestions.length <= 3);
    }
    // Never label the person: "you are a victim/blamer" style wording is banned.
    const ru = content.resultForLanguage(pattern, 'ru');
    const en = content.resultForLanguage(pattern, 'en');
    assert.ok(!/вы\s*[—-]?\s*жертва/i.test(ru.headline + ru.explanation));
    assert.ok(!/you are (a|an)\s+(victim|blamer|complainer|bad)/i.test(en.headline + en.explanation));
  }
  const common = content.resultCommonForLanguage('uz');
  assert.ok(common.reminder.length > 50 && common.encouragement.length > 50);
});

test('presentation content is Uzbek and includes the central question and per-department tips', () => {
  const p = content.presentationUz;
  assert.ok(p.centralQuestion.includes('nima qila olaman'));
  assert.ok(p.techniques.length >= 4);
  assert.ok(p.practices.length >= 4);
  for (const dept of DEPARTMENT_KEYS) {
    assert.ok(p.departmentTips[dept], `missing tips for ${dept}`);
    assert.ok(p.departmentTips[dept].sosQuestions.length >= 2);
    assert.ok(p.departmentTips[dept].technique.length > 30);
  }
});

test('content version is a positive integer', () => {
  assert.ok(Number.isInteger(content.CONTENT_VERSION) && content.CONTENT_VERSION >= 1);
});
