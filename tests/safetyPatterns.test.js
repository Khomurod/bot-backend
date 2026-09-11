/**
 * Whether a driver has a pattern, or just had a bad moment.
 *
 * Every safety alert today is an isolated incident, which is the framing that
 * makes coaching impossible: a first hard brake in traffic and the fourth this
 * week produce the same message. A driver who gets the same note every time
 * stops reading it, and the one that mattered is lost.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BEHAVIORS, DEFAULTS, normaliseBehavior, isCollision, findPatterns,
} = require('../lib/safety/patterns');

const NOW = '2026-09-20T18:00:00Z';
const ago = (days) => new Date(Date.parse(NOW) - days * 86400000).toISOString();
const ev = (behavior, days, extra = {}) => ({ behavior, occurredAt: ago(days), ...extra });
const run = (over = {}) => findPatterns({ nowIso: NOW, ...over });

// ── one behaviour, however it is spelled ─────────────────────────────────────

test('Samsara\'s four spellings of one behaviour are ONE behaviour', () => {
  // Counted separately, each spelling has one event, nothing reaches a
  // threshold, and the feature silently never fires.
  for (const spelling of ['HarshBraking', 'harsh_braking', 'Harsh Braking', 'HARSH-BRAKING']) {
    assert.equal(normaliseBehavior(spelling), BEHAVIORS.HARSH_BRAKING, spelling);
  }
  const out = run({
    events: [
      ev('HarshBraking', 1), ev('harsh_braking', 3),
      ev('Harsh Braking', 5), ev('HARSH-BRAKING', 7),
    ],
  });
  assert.equal(out.patterns.length, 1);
  assert.equal(out.patterns[0].count, 4);
});

test('the severity words Samsara puts in front of speeding all mean speeding', () => {
  for (const s of ['SevereSpeeding', 'HeavySpeeding', 'ModerateSpeeding', 'LightSpeeding', 'Speeding']) {
    assert.equal(normaliseBehavior(s), BEHAVIORS.SPEEDING, s);
  }
});

test('an unrecognised label is null, not a new pattern nobody can coach', () => {
  assert.equal(normaliseBehavior('GatewayUnplugged'), null);
  assert.equal(normaliseBehavior(''), null);
  assert.equal(normaliseBehavior(null), null);
});

test('a crash is never a coaching moment', () => {
  // It is an incident, and a person owns it. A bot telling somebody who has
  // just crashed to brake more gently would be grotesque.
  assert.equal(isCollision('Crash'), true);
  assert.equal(isCollision('Rollover'), true);
  assert.equal(isCollision('HarshBraking'), false);
  assert.equal(normaliseBehavior('Crash'), null, 'and it is not a coachable behaviour either');
});

// ── a pattern needs repetition ───────────────────────────────────────────────

test('a single event is never a pattern', () => {
  const out = run({ events: [ev('HarshBraking', 1)] });
  assert.deepEqual(out.patterns, []);
  assert.deepEqual(out.coachable, []);
});

test('below the threshold is not a pattern', () => {
  const out = run({ events: [ev('HarshBraking', 1), ev('HarshBraking', 2)] });
  assert.deepEqual(out.patterns, []);
});

test('at the threshold it is', () => {
  const out = run({
    events: Array.from({ length: DEFAULTS.minEvents }, (_, i) => ev('HarshBraking', i + 1)),
  });
  assert.equal(out.patterns.length, 1);
  assert.equal(out.coachable.length, 1);
});

test('events outside the window do not count toward one', () => {
  const out = run({
    events: [ev('HarshBraking', 1), ev('HarshBraking', 2), ev('HarshBraking', 40)],
  });
  assert.deepEqual(out.patterns, [], 'a habit two months ago is not this fortnight\'s habit');
});

test('a driver with almost no events is not coached about anything', () => {
  // Three events in a fortnight is ordinary driving. The point is a habit.
  const out = run({
    events: [ev('HarshBraking', 1), ev('HarshBraking', 2)],
    options: { minEvents: 2, minTotalEvents: 5 },
  });
  assert.equal(out.patterns.length, 1, 'the pattern exists');
  assert.deepEqual(out.coachable, [], 'but it is not worth saying anything about');
});

// ── it does not nag ──────────────────────────────────────────────────────────

test('a behaviour coached recently is not coached again', () => {
  const events = Array.from({ length: 4 }, (_, i) => ev('HarshBraking', i + 1));
  const out = run({ events, coaching: [{ behavior: 'harsh_braking', sentAt: ago(3) }] });
  assert.equal(out.patterns[0].recentlyCoached, true);
  assert.equal(out.patterns[0].daysSinceCoached, 3);
  assert.deepEqual(out.coachable, [], 'saying it again three days later is nagging');
});

test('after the quiet period it can be raised again', () => {
  const events = Array.from({ length: 4 }, (_, i) => ev('HarshBraking', i + 1));
  const out = run({ events, coaching: [{ behavior: 'harsh_braking', sentAt: ago(40) }] });
  assert.equal(out.patterns[0].recentlyCoached, false);
  assert.equal(out.coachable.length, 1, 'a habit that came back is worth mentioning again');
});

test('coaching one behaviour does not silence a different one', () => {
  const out = run({
    events: [
      ...Array.from({ length: 3 }, (_, i) => ev('HarshBraking', i + 1)),
      ...Array.from({ length: 3 }, (_, i) => ev('Speeding', i + 1)),
    ],
    coaching: [{ behavior: 'harsh_braking', sentAt: ago(2) }],
  });
  assert.deepEqual(out.coachable.map((p) => p.behavior), [BEHAVIORS.SPEEDING]);
});

test('the coaching history is matched on the normalised behaviour too', () => {
  const events = Array.from({ length: 4 }, (_, i) => ev('HarshBraking', i + 1));
  const out = run({ events, coaching: [{ behavior: 'Harsh Braking', sentAt: ago(2) }] });
  assert.equal(out.patterns[0].recentlyCoached, true, 'or the quiet period never applies');
});

// ── what the verdict carries ─────────────────────────────────────────────────

test('the numbers that justified it travel with it, to be disagreed with', () => {
  const out = run({
    events: [
      ev('HarshBraking', 1, { gForce: 0.6 }),
      ev('HarshBraking', 4, { gForce: 0.9 }),
      ev('HarshBraking', 9, { gForce: 0.4 }),
    ],
  });
  const p = out.patterns[0];
  assert.equal(p.count, 3);
  assert.equal(p.spanDays, 8);
  assert.equal(p.windowDays, DEFAULTS.windowDays);
  assert.equal(p.worstGForce, 0.9);
  assert.ok(p.lastAt);
});

test('every coachable behaviour says what the driver can actually DO', () => {
  for (const behavior of Object.values(BEHAVIORS)) {
    const out = run({ events: Array.from({ length: 3 }, (_, i) => ev(behavior, i + 1)) });
    assert.ok(out.patterns[0].coachingPoint, `${behavior} has no advice, so coaching it is just blame`);
    assert.equal(out.patterns[0].coachingPoint.includes('_'), false);
  }
});

test('the commonest pattern is first, because that is the one to mention', () => {
  const out = run({
    events: [
      ...Array.from({ length: 3 }, (_, i) => ev('HarshTurn', i + 1)),
      ...Array.from({ length: 7 }, (_, i) => ev('Speeding', i + 1)),
    ],
  });
  assert.equal(out.patterns[0].behavior, BEHAVIORS.SPEEDING);
});

test('a heavy pattern is marked for a person as well as the driver', () => {
  const out = run({
    events: Array.from({ length: DEFAULTS.escalateEvents }, (_, i) => ev('Speeding', i % 14)),
  });
  assert.equal(out.escalate.length, 1);
  assert.equal(out.patterns[0].escalate, true);
});

test('totals are reported even when nothing reaches a pattern', () => {
  const out = run({ events: [ev('HarshBraking', 1), ev('Speeding', 2)] });
  assert.equal(out.totals.inWindow, 2);
  assert.deepEqual(out.totals.byBehavior, { harsh_braking: 1, speeding: 1 });
});

test('no events at all is a clean, silent answer', () => {
  const out = run({ events: [] });
  assert.deepEqual(out.patterns, []);
  assert.deepEqual(out.coachable, []);
  assert.equal(out.totals.inWindow, 0);
});
