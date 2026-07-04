process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.BOT_TOKEN = process.env.BOT_TOKEN || 'test-bot-token';
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'test-telegram-token';
process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY = process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY || 'test-fb-key';

const test = require('node:test');
const assert = require('node:assert');
const { createCreatorControlPanel, TARGET_OPTIONS } = require('../bot/creatorBroadcastHandlers');

const CREATOR_ID = 2117922421;

function makePanel(overrides = {}) {
  const calls = { copies: [], resolves: [], searches: [], picks: [] };
  const groups = overrides.groups || [{ id: 1, telegram_group_id: '-100111', group_name: 'G1' }];
  const panel = createCreatorControlPanel({
    creatorUserId: CREATOR_ID,
    sendDelayMs: 0,
    resolveTargets: async (body) => { calls.resolves.push(body); return groups; },
    database: {
      searchGroupsByName: async (term, limit) => {
        calls.searches.push({ term, limit });
        return overrides.searchResults || [
          { id: 7, telegram_group_id: '-100777', group_name: 'WENZE UNIT # 7' },
        ];
      },
      getGroupByIdAnyType: async (id) => {
        calls.picks.push(id);
        return overrides.pickedGroup || { id, telegram_group_id: '-100777', group_name: 'WENZE UNIT # 7' };
      },
    },
    now: () => 1000,
    ...overrides.panelOptions,
  });
  return { panel, calls };
}

function ctx({ id = CREATOR_ID, chatType = 'private', chatId = 555, message, match } = {}) {
  const replies = [];
  const edits = [];
  const cbAnswers = [];
  const copies = [];
  return {
    from: { id },
    chat: { type: chatType, id: chatId },
    message: message ? { message_id: 42, ...message } : undefined,
    match,
    telegram: {
      copyMessage: async (toChatId, fromChatId, messageId) => {
        copies.push({ toChatId, fromChatId, messageId });
        return { message_id: 999 };
      },
    },
    reply: async (text, extra) => { replies.push({ text, extra }); },
    editMessageText: async (text, extra) => { edits.push({ text, extra }); },
    answerCbQuery: async (text) => { cbAnswers.push(text); },
    _replies: replies,
    _edits: edits,
    _cbAnswers: cbAnswers,
    _copies: copies,
  };
}

// ─── Authorization ───

test('unauthorized user is denied the menu', async () => {
  const { panel } = makePanel();
  const c = ctx({ id: 999, message: { text: '/panel' } });
  await panel.handleMenuCommand(c);
  assert.match(c._replies[0].text, /restricted/i);
  assert.equal(panel.sessions.size, 0);
});

test('creator in a group chat is told to use private chat', async () => {
  const { panel } = makePanel();
  const c = ctx({ chatType: 'supergroup', message: { text: '/panel' } });
  await panel.handleMenuCommand(c);
  assert.match(c._replies[0].text, /private chat/i);
});

test('creator in private chat sees the two-button menu', async () => {
  const { panel } = makePanel();
  const c = ctx({ message: { text: '/panel' } });
  await panel.handleMenuCommand(c);
  const kb = c._replies[0].extra.reply_markup.inline_keyboard;
  assert.equal(kb.length, 2);
  assert.match(kb[0][0].text, /Broadcast/i);
  assert.match(kb[1][0].text, /Single/i);
});

test('unauthorized callback is rejected', async () => {
  const { panel } = makePanel();
  const c = ctx({ id: 5, match: [null, 'all'] });
  await panel.handleTargetSelection(c);
  assert.match(c._cbAnswers[0], /not authorized/i);
});

// ─── Broadcast flow ───

test('broadcast audience selection stores the shared targeting contract', async () => {
  const { panel } = makePanel();
  await panel.handlePickBroadcast(ctx({ match: [] }));
  await panel.handleTargetSelection(ctx({ match: ['cpanel:t:ru', 'ru'] }));
  const session = panel.sessions.get(String(CREATOR_ID));
  assert.equal(session.stage, 'awaiting_broadcast_content');
  assert.deepEqual(session.target.body, TARGET_OPTIONS.ru.body);
});

test('broadcast copies the message verbatim to every resolved group', async () => {
  const groups = [
    { id: 1, telegram_group_id: '-100111', group_name: 'G1' },
    { id: 2, telegram_group_id: '-100222', group_name: 'G2' },
  ];
  const { panel, calls } = makePanel({ groups });
  await panel.handleTargetSelection(ctx({ match: ['cpanel:t:all', 'all'] }));

  const c = ctx({ message: { photo: [{ file_id: 'P1' }], caption: 'Happy 4th!' } });
  let nextCalled = false;
  await panel.handleContent(c, () => { nextCalled = true; });

  assert.equal(nextCalled, false, 'content consumed, not passed on');
  assert.deepEqual(calls.resolves[0], TARGET_OPTIONS.all.body);
  assert.equal(c._copies.length, 2, 'copied to both groups');
  assert.deepEqual(c._copies[0], { toChatId: '-100111', fromChatId: 555, messageId: 42 });
  assert.deepEqual(c._copies[1], { toChatId: '-100222', fromChatId: 555, messageId: 42 });
  assert.match(c._replies.map((r) => r.text).join(' '), /Sent: 2, Failed: 0/);
  assert.equal(panel.sessions.size, 0, 'session consumed after send');
});

test('broadcast reports per-group failures without aborting the run', async () => {
  const groups = [
    { id: 1, telegram_group_id: '-100111', group_name: 'G1' },
    { id: 2, telegram_group_id: '-100222', group_name: 'G2' },
  ];
  const { panel } = makePanel({ groups });
  await panel.handleTargetSelection(ctx({ match: ['cpanel:t:all', 'all'] }));
  const c = ctx({ message: { text: 'hi' } });
  c.telegram.copyMessage = async (toChatId) => {
    if (toChatId === '-100222') throw new Error('CHAT_WRITE_FORBIDDEN');
    return { message_id: 1 };
  };
  await panel.handleContent(c, () => {});
  assert.match(c._replies.map((r) => r.text).join(' '), /Sent: 1, Failed: 1/);
  assert.match(c._replies.map((r) => r.text).join(' '), /CHAT_WRITE_FORBIDDEN/);
});

test('empty audience reports nothing sent', async () => {
  const { panel } = makePanel({ groups: [] });
  await panel.handleTargetSelection(ctx({ match: ['cpanel:t:employee', 'employee'] }));
  const c = ctx({ message: { text: 'hi' } });
  await panel.handleContent(c, () => {});
  assert.match(c._replies.map((r) => r.text).join(' '), /nothing was sent/i);
  assert.equal(c._copies.length, 0);
});

test('all seven audiences are offered and map to real target types', () => {
  assert.deepEqual(
    Object.keys(TARGET_OPTIONS).sort(),
    ['active', 'all', 'company', 'employee', 'en', 'ru', 'uz'].sort()
  );
  assert.equal(TARGET_OPTIONS.active.body.target_type, 'all');
  assert.equal(TARGET_OPTIONS.active.body.target_active_filter, 'active');
  assert.equal(TARGET_OPTIONS.all.body.target_active_filter, 'all');
  assert.equal(TARGET_OPTIONS.employee.body.target_type, 'employee');
  assert.equal(TARGET_OPTIONS.company.body.target_type, 'other_company');
  assert.deepEqual(TARGET_OPTIONS.uz.body.target_languages, ['uz']);
});

// ─── Single-message flow ───

test('single flow searches by name then copies to the picked group', async () => {
  const { panel, calls } = makePanel();
  await panel.handlePickSingle(ctx({ match: [] }));
  assert.equal(panel.sessions.get(String(CREATOR_ID)).stage, 'awaiting_single_query');

  // Creator types a search term
  const searchCtx = ctx({ message: { text: 'unit 7' } });
  await panel.handleContent(searchCtx, () => {});
  assert.deepEqual(calls.searches[0], { term: 'unit 7', limit: 8 });
  const kb = searchCtx._replies[0].extra.reply_markup.inline_keyboard;
  assert.equal(kb[0][0].callback_data, 'cpanel:sg:7');

  // Creator picks the group
  await panel.handleGroupPick(ctx({ match: ['cpanel:sg:7', '7'] }));
  assert.equal(panel.sessions.get(String(CREATOR_ID)).stage, 'awaiting_single_content');
  assert.deepEqual(calls.picks, [7]);

  // Creator sends the message → copied to just that one group
  const sendCtx = ctx({ message: { video: { file_id: 'V1' } } });
  await panel.handleContent(sendCtx, () => {});
  assert.equal(sendCtx._copies.length, 1);
  assert.equal(sendCtx._copies[0].toChatId, '-100777');
  assert.match(sendCtx._replies.map((r) => r.text).join(' '), /Sent to/i);
  assert.equal(panel.sessions.size, 0);
});

test('single search with no matches asks again', async () => {
  const { panel } = makePanel({ searchResults: [] });
  await panel.handlePickSingle(ctx({ match: [] }));
  const c = ctx({ message: { text: 'zzz' } });
  await panel.handleContent(c, () => {});
  assert.match(c._replies[0].text, /No groups matched/i);
  assert.equal(panel.sessions.get(String(CREATOR_ID)).stage, 'awaiting_single_query');
});

// ─── Pass-through & cancel ───

test('non-creator messages pass through untouched', async () => {
  const { panel } = makePanel();
  const c = ctx({ id: 42, message: { text: 'hello' } });
  let nextCalled = false;
  await panel.handleContent(c, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test('creator message with no active session passes through', async () => {
  const { panel } = makePanel();
  const c = ctx({ message: { text: 'random note' } });
  let nextCalled = false;
  await panel.handleContent(c, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test('/cancel during a flow aborts without sending', async () => {
  const { panel } = makePanel();
  await panel.handleTargetSelection(ctx({ match: ['cpanel:t:all', 'all'] }));
  const c = ctx({ message: { text: '/cancel' } });
  await panel.handleContent(c, () => {});
  assert.match(c._replies[0].text, /cancelled/i);
  assert.equal(panel.sessions.size, 0);
  assert.equal(c._copies.length, 0);
});
