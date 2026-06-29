const test = require('node:test');
const assert = require('node:assert');
const {
  isHomeTimeApprover,
  isHomeTimeApproverUsername,
  extractMentionUsernames,
  messageMentionsApprovers,
  hasHomeTimeSignal,
  buildHomeTimeClassificationPrompt,
  buildHomeTimeDateReplyPrompt,
  buildAskForDatesMessage,
  looksLikeDateReply,
  parseHomeTimeWindowText,
  isReasonableHomeWindow,
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

test('buildHomeTimeClassificationPrompt asks for the requested window and anchors today', () => {
  const prompt = buildHomeTimeClassificationPrompt({ todayLabel: '2026-06-29' });
  assert.match(prompt, /Today is 2026-06-29/);
  assert.match(prompt, /dates_specified/);
  assert.match(prompt, /home_from/);
  assert.match(prompt, /Do NOT guess or default to today/);
});

test('buildHomeTimeDateReplyPrompt + buildAskForDatesMessage produce sensible text', () => {
  const prompt = buildHomeTimeDateReplyPrompt({ text: 'jul 2 to jul 8', todayLabel: '2026-06-29' });
  assert.match(prompt, /Today is 2026-06-29/);
  assert.match(prompt, /jul 2 to jul 8/);
  assert.match(prompt, /"found"/);
  assert.match(buildAskForDatesMessage(), /what dates/i);
});

test('looksLikeDateReply gates on plausible date tokens', () => {
  assert.equal(looksLikeDateReply('july 2 to july 8'), true);
  assert.equal(looksLikeDateReply('7/2 - 7/8'), true);
  assert.equal(looksLikeDateReply('2026-07-02 to 2026-07-08'), true);
  assert.equal(looksLikeDateReply('the 2nd through the 8th'), true);
  assert.equal(looksLikeDateReply('next monday'), true);
  assert.equal(looksLikeDateReply('ok sounds good boss'), false);
  assert.equal(looksLikeDateReply(''), false);
});

test('parseHomeTimeWindowText reads explicit ranges in several formats', () => {
  const ref = '2026-06-29T00:00:00Z';
  assert.deepStrictEqual(
    parseHomeTimeWindowText('from July 2 to July 8', ref),
    { homeFrom: '2026-07-02', homeTo: '2026-07-08' }
  );
  assert.deepStrictEqual(
    parseHomeTimeWindowText('2nd of July until 8th of July', ref),
    { homeFrom: '2026-07-02', homeTo: '2026-07-08' }
  );
  assert.deepStrictEqual(
    parseHomeTimeWindowText('7/2 - 7/8', ref),
    { homeFrom: '2026-07-02', homeTo: '2026-07-08' }
  );
  assert.deepStrictEqual(
    parseHomeTimeWindowText('2026-07-02 to 2026-07-08', ref),
    { homeFrom: '2026-07-02', homeTo: '2026-07-08' }
  );
});

test('parseHomeTimeWindowText orders dates and handles a single date', () => {
  const ref = '2026-06-29T00:00:00Z';
  // Reversed order is normalized to from <= to.
  assert.deepStrictEqual(
    parseHomeTimeWindowText('July 8 back from July 2', ref),
    { homeFrom: '2026-07-02', homeTo: '2026-07-08' }
  );
  // A single date becomes a one-day window.
  assert.deepStrictEqual(
    parseHomeTimeWindowText('just July 4', ref),
    { homeFrom: '2026-07-04', homeTo: '2026-07-04' }
  );
  assert.equal(parseHomeTimeWindowText('no dates here', ref), null);
});

test('parseHomeTimeWindowText rolls a past bare month/day to next year', () => {
  // Reference late December; "Jan 5" with no year means next January.
  const out = parseHomeTimeWindowText('Jan 5 to Jan 9', '2026-12-20T00:00:00Z');
  assert.deepStrictEqual(out, { homeFrom: '2027-01-05', homeTo: '2027-01-09' });
});

test('isReasonableHomeWindow validates shape, order and range', () => {
  const ref = '2026-06-29T00:00:00Z';
  assert.equal(isReasonableHomeWindow('2026-07-02', '2026-07-08', ref), true);
  assert.equal(isReasonableHomeWindow('2026-07-02', '2026-07-01', ref), false); // end before start
  assert.equal(isReasonableHomeWindow('1999-01-01', '1999-01-05', ref), false); // far past
  assert.equal(isReasonableHomeWindow('2030-01-01', '2030-01-05', ref), false); // beyond a year
  assert.equal(isReasonableHomeWindow('July 2', 'July 8', ref), false); // not YYYY-MM-DD
  assert.equal(isReasonableHomeWindow(null, null, ref), false);
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
