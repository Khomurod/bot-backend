process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.BOT_TOKEN = process.env.BOT_TOKEN || 'test-bot-token';
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'test-telegram-token';
process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY = process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY || 'test-fb-key';

const test = require('node:test');
const assert = require('node:assert');
const { createCreatorBroadcast, TARGET_OPTIONS } = require('../bot/creatorBroadcastHandlers');

const CREATOR_ID = 2117922421;

function makeManager(overrides = {}) {
  const calls = { sends: [], resolves: [] };
  const manager = createCreatorBroadcast({
    creatorUserId: CREATOR_ID,
    sendBroadcastToGroups: async (...args) => {
      calls.sends.push(args);
      return { sent: 1, failed: 0, errors: [] };
    },
    resolveTargets: async (body) => {
      calls.resolves.push(body);
      return [{ id: 1, telegram_group_id: '-100111', group_name: 'G1' }];
    },
    now: () => 1000,
    ...overrides,
  });
  return { manager, calls };
}

function ctx({ id = CREATOR_ID, chatType = 'private', message, match } = {}) {
  const replies = [];
  const edits = [];
  const cbAnswers = [];
  return {
    from: { id },
    chat: { type: chatType },
    message,
    match,
    reply: async (text) => { replies.push(text); },
    editMessageText: async (text) => { edits.push(text); },
    answerCbQuery: async (text) => { cbAnswers.push(text); },
    _replies: replies,
    _edits: edits,
    _cbAnswers: cbAnswers,
  };
}

test('requires a sendBroadcastToGroups function', () => {
  assert.throws(() => createCreatorBroadcast({}), /sendBroadcastToGroups/);
});

test('unauthorized user is denied broadcast command', async () => {
  const { manager, calls } = makeManager();
  const c = ctx({ id: 999, message: { text: '/broadcast' } });
  await manager.handleBroadcastCommand(c);
  assert.match(c._replies[0], /restricted/i);
  assert.equal(manager.sessions.size, 0);
  assert.equal(calls.sends.length, 0);
});

test('creator in a group chat is told to use private chat', async () => {
  const { manager } = makeManager();
  const c = ctx({ id: CREATOR_ID, chatType: 'supergroup', message: { text: '/broadcast' } });
  await manager.handleBroadcastCommand(c);
  assert.match(c._replies[0], /private chat/i);
  assert.equal(manager.sessions.size, 0);
});

test('creator in private chat opens a broadcast session', async () => {
  const { manager } = makeManager();
  const c = ctx({ message: { text: '/broadcast' } });
  await manager.handleBroadcastCommand(c);
  assert.equal(manager.sessions.get(String(CREATOR_ID)).stage, 'awaiting_target');
});

test('target selection maps to the shared targeting contract', async () => {
  const { manager } = makeManager();
  await manager.handleBroadcastCommand(ctx({ message: { text: '/broadcast' } }));
  await manager.handleTargetSelection(ctx({ match: [null, 'ru'] }));
  const session = manager.sessions.get(String(CREATOR_ID));
  assert.equal(session.stage, 'awaiting_content');
  assert.deepEqual(session.target.body, TARGET_OPTIONS.ru.body);
});

test('unauthorized callback is rejected', async () => {
  const { manager } = makeManager();
  const c = ctx({ id: 5, match: [null, 'all'] });
  await manager.handleTargetSelection(c);
  assert.match(c._cbAnswers[0], /not authorized/i);
});

test('photo-only broadcast is sent with media and empty caption', async () => {
  const { manager, calls } = makeManager();
  await manager.handleBroadcastCommand(ctx({ message: { text: '/broadcast' } }));
  await manager.handleTargetSelection(ctx({ match: [null, 'all'] }));

  const photoCtx = ctx({ message: { photo: [{ file_id: 'small' }, { file_id: 'BIG_PHOTO' }] } });
  let nextCalled = false;
  await manager.handleContent(photoCtx, () => { nextCalled = true; });

  assert.equal(nextCalled, false, 'content should be consumed, not passed on');
  assert.equal(calls.resolves.length, 1);
  assert.deepEqual(calls.resolves[0], TARGET_OPTIONS.all.body);
  const [groups, text, parseMode, messages, mediaItems] = calls.sends[0];
  assert.equal(text, '');
  assert.deepEqual(mediaItems, [{ file_id: 'BIG_PHOTO', media_type: 'photo' }]);
  assert.equal(groups.length, 1);
  assert.match(photoCtx._replies.join(' '), /Broadcast complete\. Sent: 1/);
  assert.equal(manager.sessions.size, 0, 'session consumed after send');
});

test('photo with caption forwards the caption as text', async () => {
  const { manager, calls } = makeManager();
  await manager.handleBroadcastCommand(ctx({ message: { text: '/broadcast' } }));
  await manager.handleTargetSelection(ctx({ match: [null, 'en'] }));
  await manager.handleContent(
    ctx({ message: { photo: [{ file_id: 'P1' }], caption: 'Drive safe!' } }),
    () => {}
  );
  const [, text, , , mediaItems] = calls.sends[0];
  assert.equal(text, 'Drive safe!');
  assert.equal(mediaItems[0].media_type, 'photo');
});

test('non-creator messages pass through untouched', async () => {
  const { manager, calls } = makeManager();
  const c = ctx({ id: 42, message: { text: 'hello' } });
  let nextCalled = false;
  await manager.handleContent(c, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(calls.sends.length, 0);
});

test('creator message with no active session passes through', async () => {
  const { manager, calls } = makeManager();
  const c = ctx({ message: { text: 'random note' } });
  let nextCalled = false;
  await manager.handleContent(c, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(calls.sends.length, 0);
});

test('/cancel during content stage aborts without sending', async () => {
  const { manager, calls } = makeManager();
  await manager.handleBroadcastCommand(ctx({ message: { text: '/broadcast' } }));
  await manager.handleTargetSelection(ctx({ match: [null, 'all'] }));
  const c = ctx({ message: { text: '/cancel' } });
  await manager.handleContent(c, () => {});
  assert.match(c._replies[0], /cancelled/i);
  assert.equal(calls.sends.length, 0);
  assert.equal(manager.sessions.size, 0);
});

test('empty target set reports nothing sent', async () => {
  const { manager, calls } = makeManager({ resolveTargets: async () => [] });
  await manager.handleBroadcastCommand(ctx({ message: { text: '/broadcast' } }));
  await manager.handleTargetSelection(ctx({ match: [null, 'all'] }));
  const c = ctx({ message: { text: 'hi' } });
  await manager.handleContent(c, () => {});
  assert.match(c._replies.join(' '), /nothing was sent/i);
  assert.equal(calls.sends.length, 0);
});
