'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  buildThread, renderThread, lastCandidateMessage, recruiterSpokeAfterWenze, MIRROR_SOURCES,
} = require('../lib/recruiting/thread');

function row(id, source, body, at) {
  return { id, source_type: source, sms_body: body, created_at: at };
}

const CONVERSATION = [
  row(1, 'outbound_auto', 'Hi, this is Tom at Wenze. Are you looking for OTR work?', '2026-09-11T02:00:00Z'),
  row(2, 'inbound_rc', 'Yes I am. What does it pay?', '2026-09-11T02:04:00Z'),
  row(3, 'outbound_ai', 'Pay is 77 cents per mile, paid weekly.', '2026-09-11T02:05:00Z'),
  row(4, 'inbound_rc', 'And home time?', '2026-09-11T02:09:00Z'),
];

test('a thread comes back oldest first with each side labelled', () => {
  const turns = buildThread(CONVERSATION);
  assert.deepStrictEqual(turns.map((t) => t.role), ['recruiter', 'candidate', 'wenze', 'candidate']);
  assert.strictEqual(turns[0].text, CONVERSATION[0].sms_body);
});

test('rows arriving newest-first are still ordered correctly', () => {
  const turns = buildThread([...CONVERSATION].reverse());
  assert.deepStrictEqual(turns.map((t) => t.text), CONVERSATION.map((r) => r.sms_body));
});

test('two rows in the same second are ordered by id, so an answer never precedes its question', () => {
  const sameSecond = [
    row(9, 'inbound_rc', 'second', '2026-09-11T02:00:00Z'),
    row(8, 'outbound_auto', 'first', '2026-09-11T02:00:00Z'),
  ];
  assert.deepStrictEqual(buildThread(sameSecond).map((t) => t.text), ['first', 'second']);
});

test('trimming keeps the NEWEST turns — the last thing said is what is being answered', () => {
  const turns = buildThread(CONVERSATION, { limit: 2 });
  assert.strictEqual(turns.length, 2);
  assert.strictEqual(turns[turns.length - 1].text, 'And home time?');
});

test('Wenze\'s own turns are labelled as Wenze, not merged into the recruiter\'s', () => {
  const rendered = renderThread(buildThread(CONVERSATION));
  assert.match(rendered, /You \(earlier, after hours\): Pay is 77/);
  assert.match(rendered, /Recruiter: Hi, this is Tom/);
});

test('an unknown source type is dropped rather than guessed at', () => {
  const turns = buildThread([...CONVERSATION, row(5, 'outbound_carrier_pigeon', 'hello', '2026-09-11T03:00:00Z')]);
  assert.strictEqual(turns.length, 4);
});

test('an empty body is dropped', () => {
  const turns = buildThread([...CONVERSATION, row(6, 'inbound_rc', '   ', '2026-09-11T03:00:00Z')]);
  assert.strictEqual(turns.length, 4);
});

test('the last candidate message is the one being answered', () => {
  assert.strictEqual(lastCandidateMessage(buildThread(CONVERSATION)).text, 'And home time?');
  assert.strictEqual(lastCandidateMessage([]), null);
});

test('a recruiter replying after Wenze means the conversation is theirs again', () => {
  const withHuman = [...CONVERSATION,
    row(5, 'outbound_recruiter', 'Hi, Tom here — every 3 weeks.', '2026-09-11T14:00:00Z')];
  assert.strictEqual(recruiterSpokeAfterWenze(buildThread(withHuman)), true);
});

test('a recruiter who spoke only BEFORE Wenze has not taken it back', () => {
  assert.strictEqual(recruiterSpokeAfterWenze(buildThread(CONVERSATION)), false);
});

test('the insertable source list is the readable source list', () => {
  assert.deepStrictEqual(
    [...MIRROR_SOURCES].sort(),
    ['inbound_rc', 'outbound_ai', 'outbound_auto', 'outbound_recruiter'],
  );
});

test('the mirror service takes its allow-list FROM this module', () => {
  // A source insertable by the mirror but unreadable here would vanish from
  // every thread silently, which is exactly what outbound_recruiter did before
  // it was recorded at all.
  const src = require('node:fs').readFileSync(
    require.resolve('../services/facebookLeadSmsMirrorService'), 'utf8',
  );
  assert.match(src, /new Set\(MIRROR_SOURCES\)/);
});
