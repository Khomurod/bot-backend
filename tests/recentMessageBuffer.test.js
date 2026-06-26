const test = require('node:test');
const assert = require('node:assert');
const buffer = require('../services/recentMessageBuffer');

test('records and returns recent messages oldest-first', () => {
  buffer._reset();
  const gid = -1001;
  buffer.recordMessage(gid, { sender: '@rep', text: 'driver wants home' });
  buffer.recordMessage(gid, { sender: '@disp', text: 'tagging the boss' });
  const msgs = buffer.getRecentMessages(gid);
  assert.strictEqual(msgs.length, 2);
  assert.strictEqual(msgs[0].text, 'driver wants home');
  assert.strictEqual(msgs[1].sender, '@disp');
});

test('drops messages older than the 30-minute window', () => {
  buffer._reset();
  const gid = -1002;
  const old = Date.now() - (40 * 60 * 1000);
  buffer.recordMessage(gid, { sender: '@a', text: 'old one', at: old });
  buffer.recordMessage(gid, { sender: '@b', text: 'fresh one' });
  const msgs = buffer.getRecentMessages(gid);
  assert.strictEqual(msgs.length, 1);
  assert.strictEqual(msgs[0].text, 'fresh one');
});

test('ignores empty text and is keyed per group', () => {
  buffer._reset();
  buffer.recordMessage(-1, { sender: '@a', text: '   ' });
  buffer.recordMessage(-1, { sender: '@a', text: 'hi' });
  buffer.recordMessage(-2, { sender: '@c', text: 'other group' });
  assert.strictEqual(buffer.getRecentMessages(-1).length, 1);
  assert.strictEqual(buffer.getRecentMessages(-2).length, 1);
  assert.strictEqual(buffer.getRecentMessages(-999).length, 0);
});

test('renderTranscript formats sender: text lines', () => {
  buffer._reset();
  buffer.recordMessage(7, { sender: '@rep', text: 'can driver go home' });
  buffer.recordMessage(7, { sender: '@boss', text: 'how long out' });
  assert.strictEqual(buffer.renderTranscript(7), '@rep: can driver go home\n@boss: how long out');
});

test('caps the number of buffered messages per group', () => {
  buffer._reset();
  const gid = 42;
  for (let i = 0; i < buffer.MAX_PER_GROUP + 25; i += 1) {
    buffer.recordMessage(gid, { sender: '@x', text: `m${i}` });
  }
  assert.strictEqual(buffer.getRecentMessages(gid).length, buffer.MAX_PER_GROUP);
});
