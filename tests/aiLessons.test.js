'use strict';

/**
 * lib/ai/lessons.js — the words of a learning question, what is masked before
 * it reaches the group, and the block later prompts are given.
 * See docs/architecture/ai-learning.md.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const L = require('../lib/ai/lessons');

test('every escalating decision has a scope; anything else takes no lessons', () => {
  const { ESCALATING } = require('../lib/ai/escalation');
  for (const capability of Object.keys(ESCALATING)) {
    assert.ok(L.scopeFor(capability), `${capability} has no lesson scope`);
  }
  assert.equal(L.scopeFor('employee_birthday_message'), null);
});

test('phone numbers are masked to their last four digits; a unit number is not', () => {
  assert.equal(L.maskPhones('call +1 (312) 555-0199 now'), 'call •••0199 now');
  assert.equal(L.maskPhones('reach me at 3125550199'), 'reach me at •••0199');
  assert.equal(L.maskPhones('unit 7777 is home'), 'unit 7777 is home');
});

test('the excerpt is clipped and single-line', () => {
  const out = L.contextForChat(`line one\nline two ${'x'.repeat(900)}`);
  assert.ok(out.length <= 500);
  assert.ok(!out.includes('\n'));
  assert.ok(out.endsWith('…'));
});

test('the question is plain English, names where it came from, and says how to answer', () => {
  const n = L.questionNotice({
    capability: 'safety_approval_reading', context: 'Safety: "ok go"', ask: 'What did Safety decide?', confidence: 60,
  });
  assert.equal(n.title, 'Question from Wenze — Safety Approvals');
  assert.match(n.lines[0], /about 60% sure/);
  assert.equal(n.lines[1], '"Safety: "ok go""');
  assert.equal(n.lines[2], 'What did Safety decide?');
  assert.match(n.lines[3], /reply to this message in plain words/i);
  assert.match(n.lines[3], /"skip"/);
});

test('"skip" and its friends move on; an answer that mentions skipping does not', () => {
  for (const word of ['skip', 'Skip.', 'pass', 'next', "I don't know", 'idk']) assert.ok(L.isSkip(word), word);
  assert.ok(!L.isSkip('skip the first line, the rest means approved'));
  assert.ok(!L.isSkip('approved'));
});

test('the confirmation reads "Understood: … Saved"', () => {
  assert.equal(L.understoodLine('"ok go" from Safety means approved.'),
    'Understood: "ok go" from Safety means approved. Saved — I will use this from now on.');
});

test('the prompt block: owner answers before accounting reasons, the person\'s words, capped', () => {
  assert.equal(L.renderLessonsForPrompt([]), '');
  const lessons = [
    { source: 'accounting_reason', about: 'came home early', statement: 'family emergency' },
    { source: 'owner_answer', about: 'Safety said ok go', statement: 'ok go means approved' },
  ];
  const block = L.renderLessonsForPrompt(lessons);
  assert.ok(block.indexOf('ok go means approved') < block.indexOf('family emergency'));
  assert.match(block, /The owner answered: "ok go means approved"/);
  assert.match(block, /Accounting decided: "family emergency"/);
  assert.match(block, /never override the rules above/);
  const many = Array.from({ length: 30 }, (_, i) => ({ source: 'owner_answer', about: 'a', statement: `rule ${i}` }));
  assert.equal((L.renderLessonsForPrompt(many).match(/The owner answered/g) || []).length, L.MAX_LESSONS_IN_PROMPT);
});
