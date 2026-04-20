const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeSenderStats,
  computeSenderBucketsWithStats,
  scoreAtRisk,
  scoreStar,
  detectUnacked,
  detectHotspots,
  intentDistribution,
  jsDivergence,
  parseBatchCardNarratives,
  excerpt,
} = require('../services/aiInsightsService');

function mkMsg(overrides = {}) {
  return {
    id: Math.floor(Math.random() * 1e6),
    group_id: 1,
    group_name: 'Group A',
    telegram_group_id: -1001,
    telegram_user_id: 42,
    telegram_message_id: 100,
    sender_name: 'Anthony',
    message_text: 'heading to dallas',
    created_at: new Date(),
    language: 'en',
    intent: 'status_update',
    sentiment: 0,
    urgency: 0,
    is_acknowledgement: false,
    toxic: false,
    entities_json: null,
    msg_role_guess: 'driver',
    role: 'driver',
    ...overrides,
  };
}

test('excerpt trims whitespace and enforces max length', () => {
  assert.equal(excerpt('   one  two   three   '), 'one two three');
  const long = 'x'.repeat(200);
  assert.equal(excerpt(long, 20).length, 20);
  assert.match(excerpt(long, 20), /…$/);
});

test('computeSenderStats aggregates intent counts and sentiment', () => {
  const stats = computeSenderStats({
    messages: [
      mkMsg({ intent: 'complaint', sentiment: -2 }),
      mkMsg({ intent: 'complaint', sentiment: -1 }),
      mkMsg({ intent: 'acknowledgement', sentiment: 0, is_acknowledgement: true }),
      mkMsg({ intent: 'praise', sentiment: 2 }),
    ],
  });
  assert.equal(stats.message_count, 4);
  assert.equal(stats.neg_count, 2);
  assert.equal(stats.pos_count, 1);
  assert.equal(stats.ack_count, 1);
  assert.equal(stats.sentiment_min, -2);
  assert.equal(stats.intents.complaint, 2);
  assert.equal(stats.intents.praise, 1);
});

test('scoreAtRisk weights quit_signal heaviest', () => {
  const quiet = { stats: computeSenderStats({ messages: [mkMsg({ intent: 'status_update', sentiment: 0 })] }) };
  const quitter = {
    stats: computeSenderStats({
      messages: [
        mkMsg({ intent: 'quit_signal', sentiment: -2 }),
        mkMsg({ intent: 'complaint', sentiment: -1 }),
      ],
    }),
  };
  assert.ok(scoreAtRisk(quitter) > scoreAtRisk(quiet) + 4);
});

test('scoreStar rewards positive without negatives', () => {
  const star = {
    stats: computeSenderStats({
      messages: [mkMsg({ intent: 'praise', sentiment: 2 }), mkMsg({ intent: 'praise', sentiment: 1 })],
    }),
  };
  const toxic = {
    stats: computeSenderStats({
      messages: [mkMsg({ intent: 'praise', sentiment: 2, toxic: true })],
    }),
  };
  assert.ok(scoreStar(star) > 0);
  assert.ok(scoreStar(toxic) < 0);
});

test('detectHotspots returns only hotspot-kind intents', () => {
  const msgs = [
    mkMsg({ intent: 'breakdown' }),
    mkMsg({ intent: 'accident' }),
    mkMsg({ intent: 'conflict' }),
    mkMsg({ intent: 'status_update' }),
    mkMsg({ intent: 'social' }),
  ];
  const out = detectHotspots(msgs);
  assert.equal(out.length, 3);
});

test('detectUnacked flags urgent dispatcher messages without driver reply in window', () => {
  const t0 = new Date('2026-04-18T10:00:00Z');
  const t1 = new Date('2026-04-18T10:05:00Z');
  const t2 = new Date('2026-04-18T10:45:00Z'); // outside 30-min window
  const msgs = [
    mkMsg({ role: 'dispatcher', urgency: 2, message_text: 'need ETA now', created_at: t0, telegram_user_id: 1 }),
    mkMsg({ role: 'driver', urgency: 0, created_at: t1, telegram_user_id: 42, intent: 'acknowledgement' }),
    // Second urgent dispatcher msg, only a late driver reply
    mkMsg({ role: 'dispatcher', urgency: 3, message_text: 'STATUS?', created_at: t0, telegram_user_id: 1, group_id: 2, group_name: 'B', id: 999 }),
    mkMsg({ role: 'driver', urgency: 0, created_at: t2, telegram_user_id: 42, group_id: 2, intent: 'status_update' }),
  ];
  const out = detectUnacked(msgs);
  // First dispatcher msg IS acked, second is not.
  assert.equal(out.length, 1);
  assert.equal(out[0].group_id, 2);
});

test('intentDistribution normalizes to probabilities', () => {
  const p = intentDistribution({ a: 1, b: 3 });
  assert.equal(p.a, 0.25);
  assert.equal(p.b, 0.75);
});

test('jsDivergence is 0 for identical, >0 for different', () => {
  assert.equal(jsDivergence({ a: 0.5, b: 0.5 }, { a: 0.5, b: 0.5 }), 0);
  assert.ok(jsDivergence({ a: 1 }, { b: 1 }) > 0.9);
});

test('parseBatchCardNarratives handles valid JSON object correctly', () => {
  const out = parseBatchCardNarratives('{"card1":{"narrative_html":"<b>hi</b>","suggested_action":"call","severity":3}}');
  assert.equal(out.card1.narrative_html, '<b>hi</b>');
  assert.equal(out.card1.suggested_action, 'call');
  assert.equal(out.card1.severity, 3);
});

test('parseBatchCardNarratives falls back on non-JSON text', () => {
  const out = parseBatchCardNarratives('just a narrative sentence');
  assert.deepEqual(out, {});
});

test('parseBatchCardNarratives clamps severity to 1..3', () => {
  assert.equal(parseBatchCardNarratives('{"c1":{"severity":99}}').c1.severity, 3);
  assert.equal(parseBatchCardNarratives('{"c2":{"severity":-4}}').c2.severity, 1);
});

test('computeSenderBucketsWithStats splits by (group,user)', () => {
  const msgs = [
    mkMsg({ telegram_user_id: 1, group_id: 1 }),
    mkMsg({ telegram_user_id: 1, group_id: 1 }),
    mkMsg({ telegram_user_id: 2, group_id: 1 }),
    mkMsg({ telegram_user_id: 1, group_id: 2 }),
  ];
  const buckets = computeSenderBucketsWithStats(msgs);
  assert.equal(buckets.length, 3);
});
