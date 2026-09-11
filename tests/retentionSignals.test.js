'use strict';

/**
 * Why a driver might be about to leave.
 *
 * The property this file exists to hold is what the module REFUSES to be. The
 * obvious implementation of "retention risk" scores how a driver behaves — how
 * much they complain, how often they are coached — and produces a performance
 * file nobody agreed to, assembled by a machine, about people who cannot see
 * it. It would also be useless: a driver leaves because they have been out five
 * weeks and their home request expired unanswered, and the actionable half of
 * that sentence is entirely the company's.
 *
 * So: promises not kept, money not paid, time not given, and the driver's own
 * words. Nothing else.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assess, assessAll, suggestActions, WEIGHTS, THRESHOLDS,
} = require('../lib/retention/signals');

const NOW = '2026-09-11T00:00:00Z';
const CALM = {
  name: 'Sam Rivera', personId: 11, groupId: 7,
  quitSignals: 0, complaints: 0, avgSentiment: 0.4,
  baselineMessages: 20, recentMessages: 18,
  roadWeeksOverAllowance: 0, brokenHomeCommitments: 0,
  unansweredHomeRequests: 0, deniedHomeRequests: 0,
  unpaidBonusUsd: 0, unpaidBonusCount: 0, raiseNotQualifiedRounds: 0,
  emptySince: null,
};
const at = (over) => assess({ ...CALM, ...over }, { now: NOW });

test('a driver with nothing wrong produces nothing', () => {
  const out = at({});
  assert.equal(out.score, 0);
  assert.equal(out.level, 'none');
  assert.deepEqual(out.signals, []);
});

test('one small thing is not a flag', () => {
  // A single declined home request is a normal week, not a resignation.
  const out = at({ deniedHomeRequests: 1 });
  assert.equal(out.level, 'none', 'below the notice threshold');
});

test('saying they are leaving is the heaviest single signal, because it is the only one that is not an inference', () => {
  const out = at({ quitSignals: 1 });
  assert.equal(out.level, 'watch');
  assert.equal(out.signals[0].key, 'quit_signal');
  assert.ok(WEIGHTS.quit_signal > WEIGHTS.complaints);
  assert.match(out.actions[0], /Ring them today/);
});

test('a broken home promise on top of an over-run road clock is urgent', () => {
  const out = at({ roadWeeksOverAllowance: 3, brokenHomeCommitments: 1, unansweredHomeRequests: 1 });
  assert.equal(out.level, 'urgent');
  assert.ok(out.score >= THRESHOLDS.urgent);
  assert.match(out.actions.join(' '), /home time request/);
});

test('silence counts against the driver\'s OWN baseline, never an absolute', () => {
  // Somebody who never texted much is not a risk.
  const quietByNature = at({ baselineMessages: 2, recentMessages: 0 });
  assert.ok(!quietByNature.signals.some((s) => s.key === 'gone_quiet'));

  const stopped = at({ baselineMessages: 30, recentMessages: 0 });
  assert.ok(stopped.signals.some((s) => s.key === 'gone_quiet'));
});

test('one complaint is a day; several are a pattern', () => {
  assert.ok(!at({ complaints: 1 }).signals.some((s) => s.key === 'complaints'));
  assert.ok(at({ complaints: 3 }).signals.some((s) => s.key === 'complaints'));
});

test('unpaid bonus is named in dollars when the amount is known', () => {
  const out = at({ unpaidBonusUsd: 400, roadWeeksOverAllowance: 2 });
  const s = out.signals.find((x) => x.key === 'bonus_unpaid');
  assert.match(s.detail, /\$400/);
  assert.match(out.actions.join(' '), /bonus has not been paid/);
});

test('a count is used when no amount is known, rather than inventing a figure', () => {
  const out = at({ unpaidBonusCount: 2, roadWeeksOverAllowance: 2 });
  const s = out.signals.find((x) => x.key === 'bonus_unpaid');
  assert.match(s.detail, /2 earned bonuses/);
  assert.ok(!/\$/.test(s.detail), 'no dollar figure is invented');
});

test('sitting empty is measured in days from when it started', () => {
  const out = at({ emptySince: '2026-09-05T00:00:00Z', roadWeeksOverAllowance: 1 });
  const s = out.signals.find((x) => x.key === 'sitting_empty');
  assert.match(s.detail, /6 days/);
});

test('one day empty is not a signal', () => {
  const out = at({ emptySince: '2026-09-10T00:00:00Z' });
  assert.ok(!out.signals.some((s) => s.key === 'sitting_empty'));
});

test('signals come back heaviest first, so the top reason is the real one', () => {
  const out = at({ quitSignals: 1, deniedHomeRequests: 2, complaints: 3 });
  assert.equal(out.signals[0].key, 'quit_signal');
  assert.match(out.topReason, /leaving/);
  for (let i = 1; i < out.signals.length; i += 1) {
    assert.ok(out.signals[i - 1].weight >= out.signals[i].weight);
  }
});

// ── the line the module must not cross ──────────────────────────────────────

test('NO SIGNAL IS AN ASSESSMENT OF THE DRIVER', () => {
  // Everything scored is something the company did, or something the driver
  // said. There is no "refused loads", no "coached three times", no lateness.
  const everything = at({
    quitSignals: 2, complaints: 5, avgSentiment: -1.8, baselineMessages: 40, recentMessages: 0,
    roadWeeksOverAllowance: 4, brokenHomeCommitments: 2, unansweredHomeRequests: 2,
    deniedHomeRequests: 3, unpaidBonusUsd: 900, raiseNotQualifiedRounds: 2,
    emptySince: '2026-09-01T00:00:00Z',
  });
  const text = JSON.stringify(everything).toLowerCase();
  for (const word of [
    'performance', 'attitude', 'unreliable', 'lazy', 'poor', 'discipline',
    'terminate', 'replace', 'warning', 'probation', 'fire',
  ]) {
    assert.ok(!text.includes(word), `a retention signal must never say "${word}"`);
  }
});

test('EVERY SUGGESTED ACTION IS SOMETHING THE COMPANY DOES', () => {
  const everything = at({
    quitSignals: 1, complaints: 4, roadWeeksOverAllowance: 3,
    brokenHomeCommitments: 1, unpaidBonusUsd: 500,
    emptySince: '2026-09-01T00:00:00Z', raiseNotQualifiedRounds: 1,
  });
  assert.ok(everything.actions.length > 0);
  for (const action of everything.actions) {
    assert.match(action, /^(Ring|Answer|Get|Check|Find|Read|Tell)/, action);
  }
});

test('at most three actions — a list of eight is a list nobody starts', () => {
  const out = at({
    quitSignals: 1, complaints: 4, roadWeeksOverAllowance: 3, brokenHomeCommitments: 1,
    unansweredHomeRequests: 1, unpaidBonusUsd: 500, raiseNotQualifiedRounds: 2,
    emptySince: '2026-09-01T00:00:00Z', baselineMessages: 40, recentMessages: 0,
  });
  assert.ok(out.actions.length <= 3);
});

test('suggestActions is empty for no signals, rather than offering a platitude', () => {
  assert.deepEqual(suggestActions([]), []);
});

// ── the fleet view ──────────────────────────────────────────────────────────

test('only drivers above the threshold come back, most at risk first', () => {
  const out = assessAll([
    { ...CALM, name: 'Calm' },
    { ...CALM, name: 'Watch', deniedHomeRequests: 2, complaints: 2 },
    { ...CALM, name: 'Urgent', quitSignals: 1, roadWeeksOverAllowance: 3, unpaidBonusUsd: 300 },
  ], { now: NOW });

  assert.deepEqual(out.map((a) => a.driver.name), ['Urgent', 'Watch']);
  assert.equal(out[0].level, 'urgent');
});

test('an empty fleet is an empty list, not a crash', () => {
  assert.deepEqual(assessAll(null, { now: NOW }), []);
  assert.deepEqual(assessAll([], { now: NOW }), []);
});
