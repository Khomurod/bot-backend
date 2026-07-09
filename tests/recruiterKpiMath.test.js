/**
 * Unit tests for the recruiter KPI math (database/ringcentral.js).
 *
 * Main business rule under test: the primary daily KPI is REAL call duration
 * (2h 30m = 9000s per recruiter per day) and calls shorter than 30 seconds do
 * NOT count toward it.
 */
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.JWT_SECRET ||= 'test-secret';
process.env.BOT_TOKEN ||= '123:test-bot-token';
process.env.TELEGRAM_BOT_TOKEN ||= '123:test-bot-token';
process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY ||= 'test-encryption-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  summarizeCalls,
  computeRecruiterKpis,
  buildTargets,
  formatTalkLabel,
  resolveThresholds,
  DEFAULT_TARGET_TALK_SECONDS,
} = require('../database/ringcentral');

const thresholds = resolveThresholds({});
const dayTargets = buildTargets({}, 1);

function call(durationSeconds, direction = 'Outbound') {
  return { direction, durationSeconds };
}

test('default target is 2h30m (9000s) and label reads "2h 30m"', () => {
  assert.equal(DEFAULT_TARGET_TALK_SECONDS, 9000);
  assert.equal(dayTargets.talkSeconds, 9000);
  assert.equal(dayTargets.talkMinutes, 150);
  assert.equal(dayTargets.talkLabel, '2h 30m');
  assert.equal(dayTargets.outbound, 150);
});

test('calls under 30 seconds do NOT count toward valuableTalkSeconds', () => {
  const totals = summarizeCalls([call(5), call(15), call(29)], thresholds);
  assert.equal(totals.valuableTalkSeconds, 0);
  assert.equal(totals.nonValuableCalls, 3);
  assert.equal(totals.nonValuableSeconds, 49);
  // Raw talk time still includes them — but it is never the main KPI.
  assert.equal(totals.totalTalkSeconds, 49);
});

test('a call of exactly 30 seconds counts', () => {
  const totals = summarizeCalls([call(30)], thresholds);
  assert.equal(totals.valuableTalkSeconds, 30);
  assert.equal(totals.nonValuableCalls, 0);
});

test('29s + 30s + 60s → only 30 + 60 count toward the main KPI', () => {
  const totals = summarizeCalls([call(29), call(30), call(60)], thresholds);
  assert.equal(totals.valuableTalkSeconds, 90);
  assert.equal(totals.totalTalkSeconds, 119);
  assert.equal(totals.nonValuableCalls, 1);
  assert.equal(totals.nonValuableSeconds, 29);
});

test('45s and 2min calls count; zero-duration calls are not "non-valuable"', () => {
  const totals = summarizeCalls([call(45), call(120), call(0)], thresholds);
  assert.equal(totals.valuableTalkSeconds, 165);
  assert.equal(totals.nonValuableCalls, 0);
  assert.equal(totals.totalCalls, 3);
});

test('a changed nonValuableMaxSeconds setting moves the cutoff', () => {
  const custom = resolveThresholds({ nonValuableMaxSeconds: 45 });
  const totals = summarizeCalls([call(40), call(45)], custom);
  assert.equal(totals.valuableTalkSeconds, 45);
  assert.equal(totals.nonValuableCalls, 1);
});

test('real (>1m) and strong (>3m) conversation counters still work', () => {
  const totals = summarizeCalls([call(59), call(60), call(180), call(200, 'Inbound')], thresholds);
  assert.equal(totals.realConversations, 3);
  assert.equal(totals.strongConversations, 2);
  assert.equal(totals.outbound, 3);
  assert.equal(totals.inbound, 1);
});

test('2.5h of valuable talk gives talkPct 100 and talkMet', () => {
  const totals = summarizeCalls([call(9000)], thresholds);
  const kpis = computeRecruiterKpis(totals, dayTargets);
  assert.equal(kpis.talkPct, 100);
  assert.equal(kpis.talkMet, true);
  assert.equal(kpis.talkRemainingSeconds, 0);
});

test('main score weights talk time 70% and outbound 30%', () => {
  // Full talk time, zero outbound → 70.
  const talkOnly = computeRecruiterKpis(summarizeCalls([call(9000)], thresholds), dayTargets);
  assert.equal(talkOnly.mainScore, 70);
  // Full outbound (150 short-but-valuable calls of 60s), zero talk progress is
  // impossible with real calls, so check the pure formula with zero talk:
  const outboundOnly = computeRecruiterKpis(
    { ...summarizeCalls([], thresholds), outbound: 150 },
    dayTargets
  );
  assert.equal(outboundOnly.outboundPct, 100);
  assert.equal(outboundOnly.mainScore, 30);
  // Talk time dominates: 100% talk / 0% outbound outranks 0% talk / 100% outbound.
  assert.ok(talkOnly.mainScore > outboundOnly.mainScore);
});

test('activityScore is kept as a backward-compatible alias of mainScore', () => {
  const kpis = computeRecruiterKpis(summarizeCalls([call(4500), call(60)], thresholds), dayTargets);
  assert.equal(kpis.activityScore, kpis.mainScore);
});

test('150 outbound calls hit the secondary target', () => {
  const calls = Array.from({ length: 150 }, () => call(10));
  const kpis = computeRecruiterKpis(summarizeCalls(calls, thresholds), dayTargets);
  assert.equal(kpis.outbound, 150);
  assert.equal(kpis.outboundPct, 100);
  assert.equal(kpis.outboundMet, true);
  // …but 150 ten-second calls give ZERO real talk time.
  assert.equal(kpis.valuableTalkSeconds, 0);
  assert.equal(kpis.talkPct, 0);
});

test('talkRemainingSeconds counts down to the target', () => {
  const kpis = computeRecruiterKpis(summarizeCalls([call(6900)], thresholds), dayTargets);
  assert.equal(kpis.talkRemainingSeconds, 2100); // 35m left to hit 2h 30m
  assert.equal(kpis.talkMet, false);
});

test('range targets scale linearly with the number of days', () => {
  const threeDay = buildTargets({}, 3);
  assert.equal(threeDay.talkSeconds, 27000);
  assert.equal(threeDay.talkLabel, '7h 30m');
  assert.equal(threeDay.outbound, 450);
  const custom = buildTargets({ targetTalkSeconds: 6000, targetOutbound: 100 }, 2);
  assert.equal(custom.talkSeconds, 12000);
  assert.equal(custom.outbound, 200);
});

test('formatTalkLabel renders h/m labels', () => {
  assert.equal(formatTalkLabel(9000), '2h 30m');
  assert.equal(formatTalkLabel(2700), '45m');
  assert.equal(formatTalkLabel(3600), '1h');
  assert.equal(formatTalkLabel(0), '0m');
});
