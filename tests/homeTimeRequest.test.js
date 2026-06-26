const test = require('node:test');
const assert = require('node:assert');
const {
  isHomeTimeApprover,
  isHomeTimeApproverUsername,
  extractMentionUsernames,
  messageMentionsApprovers,
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

test('weeksFromDays converts and rounds to one decimal', () => {
  assert.strictEqual(weeksFromDays(28), 4);
  assert.strictEqual(weeksFromDays(35), 5);
  assert.strictEqual(weeksFromDays(10), 1.4);
  assert.strictEqual(weeksFromDays(0), 0);
  assert.strictEqual(weeksFromDays(-5), 0);
});

test('isPolicyMet: met at/over allowance, short under it, null when unknown', () => {
  assert.strictEqual(isPolicyMet(28, 4), true);  // exactly 4 weeks
  assert.strictEqual(isPolicyMet(40, 4), true);
  assert.strictEqual(isPolicyMet(27, 4), false); // one day short
  assert.strictEqual(isPolicyMet(0, 4), false);
  assert.strictEqual(isPolicyMet(null, 4), null);
  assert.strictEqual(isPolicyMet(undefined, 4), null);
});

test('computeHomeWindow returns an inclusive N-day window', () => {
  const w = computeHomeWindow('2026-06-01T12:00:00Z', 4, 'America/Chicago');
  assert.strictEqual(w.homeFrom, '2026-06-01');
  assert.strictEqual(w.homeTo, '2026-06-04'); // 4 inclusive days: 1,2,3,4
});
