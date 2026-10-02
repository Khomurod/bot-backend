/**
 * Rehearsals → a proposal to go automatic. Proposes only; never applies.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { assessPractice, describePracticeProposal, proposePractice } = require('../lib/operations/practiceReadiness');

const DAY = 24 * 3600 * 1000;
const row = (over = {}) => ({
  checkKey: 'board.person_link', subjects: 40, flips: 1, rejected: 0, confirmed: 0,
  firstAt: new Date(Date.parse('2026-10-02T00:00:00Z') - 12 * DAY).toISOString(),
  lastAt: '2026-10-02T00:00:00Z', ...over,
});
const ctx = { modes: { 'board.person_link': 'suggest' }, tiers: { 'board.person_link': 'auto' } };

test('a steady, unobjected record over enough days is proposed', () => {
  const [p] = assessPractice([row()], ctx);
  assert.equal(p.checkKey, 'board.person_link');
  assert.equal(p.subjects, 40);
  assert.equal(p.days, 12);
});

test('ONE rejection by a person is enough to say nothing', () => {
  assert.deepEqual(assessPractice([row({ rejected: 1 })], ctx), []);
});

test('too few cases, or too short a record, is not a record', () => {
  assert.deepEqual(assessPractice([row({ subjects: 9 })], ctx), []);
  assert.deepEqual(assessPractice([row({ firstAt: new Date(Date.parse('2026-10-02T00:00:00Z') - 3 * DAY).toISOString() })], ctx), []);
});

test('a check that keeps changing its mind is too unsteady', () => {
  assert.deepEqual(assessPractice([row({ subjects: 40, flips: 5 })], ctx), [], '12.5% > 10%');
  assert.equal(assessPractice([row({ subjects: 40, flips: 4 })], ctx).length, 1, '10% is the edge');
});

test('a check already on Autopilot, or one whose action needs a person, is never proposed', () => {
  assert.deepEqual(assessPractice([row()], { ...ctx, modes: { 'board.person_link': 'autopilot' } }), []);
  assert.deepEqual(assessPractice([row()], { ...ctx, tiers: { 'board.person_link': 'approval' } }), []);
  assert.deepEqual(assessPractice([row()], { modes: {}, tiers: {} }), [], 'an unknown tier is not auto');
});

test('the proposal carries NO action — switching automation on is a person\'s act', () => {
  const [s] = proposePractice([row()], ctx);
  assert.equal(s.kind, 'practice_ready');
  assert.equal(s.applyAction, null);
  assert.equal(s.evidence.applicable, false);
  assert.match(s.suggestion, /the switch itself is yours to make/);
});

test('it says plainly when nobody has confirmed anything yet', () => {
  const s = describePracticeProposal({ checkKey: 'board.person_link', subjects: 40, flips: 1, rejected: 0, confirmed: 0, days: 12, mode: 'suggest' });
  assert.match(s.lines.join(' '), /Nobody has confirmed or rejected any of them yet/);
  const c = describePracticeProposal({ checkKey: 'board.person_link', subjects: 40, flips: 1, rejected: 0, confirmed: 7, days: 12, mode: 'suggest' });
  assert.match(c.lines.join(' '), /A person confirmed 7 of them; nobody rejected any/);
});
