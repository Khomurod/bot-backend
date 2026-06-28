const test = require('node:test');
const assert = require('node:assert');
const {
  isHomeTimeApprover,
  isHomeTimeApproverUsername,
  extractMentionUsernames,
  messageMentionsApprovers,
  hasHomeTimeSignal,
  buildHomeTimeClassificationPrompt,
  weeksFromDays,
  isPolicyMet,
  computeHomeWindow,
} = require('../services/homeTimeRequestConstants');

test('isHomeTimeApproverUsername matches the two approvers (case-insensitive, @-tolerant)', () => {
  assert.strictEqual(isHomeTimeApproverUsername('tomr_robins0n'), true);
  assert.strictEqual(isHomeTimeApproverUsername('@TomR_Robins0n'), true);
  assert.strictEqual(isHomeTimeApproverUsername('saffiebnett'), true);
  assert.strictEqual(isHomeTimeApproverUsername('someone_else'), false);
  assert.strictEqual(isHomeTimeApproverUsername(''), false);
  assert.strictEqual(isHomeTimeApproverUsername(null), false);
});

test('isHomeTimeApprover falls back to username when no ids configured', () => {
  assert.strictEqual(isHomeTimeApprover({ username: 'SaffieBNett' }), true);
  assert.strictEqual(isHomeTimeApprover({ username: 'random', id: 5 }), false);
});

test('extractMentionUsernames reads mention entities and a regex fallback', () => {
  const withEntities = {
    text: 'hey @tomr_robins0n can you check',
    entities: [{ type: 'mention', offset: 4, length: 14 }],
  };
  assert.deepStrictEqual(extractMentionUsernames(withEntities).sort(), ['tomr_robins0n']);

  const noEntities = { text: 'ping @SaffieBNett and @driverbob please' };
  assert.deepStrictEqual(extractMentionUsernames(noEntities).sort(), ['driverbob', 'saffiebnett']);
});

test('messageMentionsApprovers detects @mention, text_mention, and ignores others', () => {
  assert.strictEqual(
    messageMentionsApprovers({ text: 'driver wants home @tomr_robins0n' }),
    true
  );
  assert.strictEqual(
    messageMentionsApprovers({
      text: 'home time?',
      entities: [{ type: 'text_mention', offset: 0, length: 4, user: { username: 'SaffieBNett' } }],
    }),
    true
  );
  assert.strictEqual(messageMentionsApprovers({ text: 'just a normal message' }), false);
  assert.strictEqual(messageMentionsApprovers({ text: 'thanks @dispatch_joe' }), false);
});

test('hasHomeTimeSignal detects home-time / time-off wording', () => {
  assert.strictEqual(hasHomeTimeSignal('driver wants to go home next week'), true);
  assert.strictEqual(hasHomeTimeSignal('Can he get some home time?'), true);
  assert.strictEqual(hasHomeTimeSignal('he needs a few days off'), true);
  assert.strictEqual(hasHomeTimeSignal('asking for hometime'), true);
  assert.strictEqual(hasHomeTimeSignal('he wants to be at the house for a bit'), true);
  assert.strictEqual(hasHomeTimeSignal('requesting PTO'), true);
});

test('hasHomeTimeSignal ignores ordinary dispatch chatter (no false positives)', () => {
  assert.strictEqual(
    hasHomeTimeSignal('I think we gonna need an oil change this is the second time I recommend it'),
    false
  );
  assert.strictEqual(hasHomeTimeSignal('Rate confirmation issue on this load'), false);
  assert.strictEqual(hasHomeTimeSignal('Truck broke down, need a tow'), false);
  assert.strictEqual(hasHomeTimeSignal('Where is the BOL for this load?'), false);
  assert.strictEqual(hasHomeTimeSignal(''), false);
  assert.strictEqual(hasHomeTimeSignal(null), false);
});

test('buildHomeTimeClassificationPrompt embeds trigger, transcript, approvers and JSON shape', () => {
  const prompt = buildHomeTimeClassificationPrompt({
    transcript: '@rep: driver out 5 weeks\n@rep: can he go home',
    triggerText: 'can he go home @tomr_robins0n',
    approvers: ['@tomr_robins0n', '@SaffieBNett'],
  });
  assert.match(prompt, /can he go home @tomr_robins0n/);
  assert.match(prompt, /driver out 5 weeks/);
  assert.match(prompt, /@tomr_robins0n, @SaffieBNett/);
  assert.match(prompt, /is_home_time_request/);
  assert.match(prompt, /confidence/);
  // Carries the few-shot oil-change counter-example that anchors the classifier.
  assert.match(prompt, /oil change/i);
});

test('buildHomeTimeClassificationPrompt tolerates missing trigger/transcript', () => {
  const prompt = buildHomeTimeClassificationPrompt({});
  assert.match(prompt, /\(unavailable\)/);
  assert.match(prompt, /no recent messages/);
});

test('weeksFromDays converts and rounds to one decimal', () => {
  assert.strictEqual(weeksFromDays(28), 4);
  assert.strictEqual(weeksFromDays(35), 5);
  assert.strictEqual(weeksFromDays(10), 1.4);
  assert.strictEqual(weeksFromDays(0), 0);
  assert.strictEqual(weeksFromDays(-5), 0);
});

test('isPolicyMet: met at/over allowance, short under it, null when unknown', () => {
  assert.strictEqual(isPolicyMet(28, 4), true);
  assert.strictEqual(isPolicyMet(40, 4), true);
  assert.strictEqual(isPolicyMet(27, 4), false);
  assert.strictEqual(isPolicyMet(0, 4), false);
  assert.strictEqual(isPolicyMet(null, 4), null);
  assert.strictEqual(isPolicyMet(undefined, 4), null);
});

test('isPolicyMet returns null for owner operators because the company policy does not apply', () => {
  assert.strictEqual(isPolicyMet(40, 4, 'owner'), null);
  assert.strictEqual(isPolicyMet(10, 4, 'owner'), null);
});

test('computeHomeWindow returns an inclusive N-day window', () => {
  const w = computeHomeWindow('2026-06-01T12:00:00Z', 4, 'America/Chicago');
  assert.strictEqual(w.homeFrom, '2026-06-01');
  assert.strictEqual(w.homeTo, '2026-06-04');
});
