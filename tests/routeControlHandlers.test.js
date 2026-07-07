const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Load the handler with mocked collaborators. Each call resets module state
// (in-memory dedupe + pending confirmations) by clearing the require cache.
function loadHandler(fakes = {}) {
  const calls = {
    assignRoute: [],
    cancelActive: [],
    events: [],
    sent: [],
  };
  const paths = {
    handler: path.resolve(__dirname, '../bot/routeControlHandlers.js'),
    db: path.resolve(__dirname, '../database/db.js'),
    ra: path.resolve(__dirname, '../database/raiseApproval.js'),
    rc: path.resolve(__dirname, '../database/routeControl.js'),
    service: path.resolve(__dirname, '../services/routeControlService.js'),
    html: path.resolve(__dirname, '../services/telegramHtml.js'),
    consts: path.resolve(__dirname, '../services/routeControlConstants.js'),
  };
  for (const p of Object.values(paths)) delete require.cache[p];

  require.cache[paths.db] = {
    exports: {
      async getGroupByTelegramId() {
        return fakes.group === undefined
          ? { id: 1, group_type: 'driver', active: true, telegram_group_id: -100123 }
          : fakes.group;
      },
    },
  };
  require.cache[paths.ra] = {
    exports: {
      async findActiveTeamMembersByUsername() { return fakes.memberTeams || []; },
      async findActiveTeamMembersByUserId() { return []; },
      async getActiveTeamIdsForGroup() { return fakes.groupTeams || []; },
    },
  };
  require.cache[paths.rc] = {
    exports: {
      async findRouteAssignmentByTelegramMessage() { return fakes.dedupHit || null; },
      async getActiveRouteAssignmentByGroupId() { return fakes.existingActive || null; },
      async insertRouteMonitorEvent(e) { calls.events.push(e); return { id: 1 }; },
    },
  };
  require.cache[paths.service] = {
    exports: {
      async parseRouteLink(url) {
        if (fakes.parseThrows) { const e = new Error('unparseable'); e.code = 'UNPARSEABLE_LINK'; throw e; }
        return { parseable: true, origin: { raw: 'A' }, destination: { raw: 'B' }, waypoints: [], url };
      },
      async assignRoute(args) { calls.assignRoute.push(args); return { geometryPending: Boolean(fakes.geometryPending) }; },
      async cancelActiveRoutesForGroup(groupId, opts) { calls.cancelActive.push({ groupId, opts }); return 1; },
    },
  };
  require.cache[paths.html] = { exports: { safeSend: async (fn) => fn() } };
  require.cache[paths.consts] = { exports: { isGlobalRouteAdmin: () => Boolean(fakes.isGlobalAdmin) } };

  const mod = require(paths.handler);
  return { mod, calls };
}

function messageCtx(text, opts = {}) {
  const chatId = opts.chatId ?? -100123;
  const sent = [];
  return {
    chat: { id: chatId, type: 'supergroup' },
    from: { id: opts.userId ?? 555, username: opts.username ?? 'disp_alice', is_bot: false },
    message: { message_id: opts.messageId ?? 42, text },
    telegram: { async sendMessage(cid, t, extra) { sent.push({ cid, t, extra }); return { message_id: 1000 }; } },
    sent,
  };
}

const DIR_LINK = 'https://www.google.com/maps/dir/Chicago/Dallas/@1,2,6z/data=x';

test('authorized dispatch member assigning a directions link creates an assignment', async () => {
  const { mod, calls } = loadHandler({ memberTeams: [{ team_id: 9 }], groupTeams: [9] });
  const ctx = messageCtx(DIR_LINK);
  const res = await mod.handleRouteMessage(ctx);
  assert.equal(res.reason, 'assigned');
  assert.equal(calls.assignRoute.length, 1);
  assert.equal(calls.assignRoute[0].source, 'telegram');
  assert.equal(calls.assignRoute[0].telegramMessageId, 42);
  assert.match(ctx.sent[0].t, /assigned route saved/i);
});

test('global admin is authorized even without team membership', async () => {
  const { mod, calls } = loadHandler({ isGlobalAdmin: true, memberTeams: [], groupTeams: [] });
  const res = await mod.handleRouteMessage(messageCtx(DIR_LINK));
  assert.equal(res.reason, 'assigned');
  assert.equal(calls.assignRoute.length, 1);
});

test('unauthorized user cannot assign a route', async () => {
  const { mod, calls } = loadHandler({ memberTeams: [], groupTeams: [9] });
  const ctx = messageCtx(DIR_LINK);
  const res = await mod.handleRouteMessage(ctx);
  assert.match(res.reason, /^unauthorized/);
  assert.equal(calls.assignRoute.length, 0);
  assert.match(ctx.sent[0].t, /only authorized dispatch\/admin/i);
});

test('a random Google Maps location pin is ignored (not assigned)', async () => {
  const { mod, calls } = loadHandler({ memberTeams: [{ team_id: 9 }], groupTeams: [9] });
  const ctx = messageCtx('truck stop here https://www.google.com/maps/place/Loves');
  const res = await mod.handleRouteMessage(ctx);
  assert.equal(res.handled, false);
  assert.equal(calls.assignRoute.length, 0);
  assert.equal(ctx.sent.length, 0);
});

test('an unparseable route link does not create an assignment and explains', async () => {
  const { mod, calls } = loadHandler({ memberTeams: [{ team_id: 9 }], groupTeams: [9], parseThrows: true });
  const ctx = messageCtx(DIR_LINK);
  const res = await mod.handleRouteMessage(ctx);
  assert.equal(res.reason, 'unparseable');
  assert.equal(calls.assignRoute.length, 0);
  assert.match(ctx.sent[0].t, /could not read this route link/i);
});

test('geometry-pending assignment replies with the pending message', async () => {
  const { mod } = loadHandler({ memberTeams: [{ team_id: 9 }], groupTeams: [9], geometryPending: true });
  const ctx = messageCtx(DIR_LINK);
  const res = await mod.handleRouteMessage(ctx);
  assert.equal(res.reason, 'assigned_pending');
  assert.match(ctx.sent[0].t, /geometry is pending|not configured/i);
});

test('an existing active route asks for confirmation instead of overwriting', async () => {
  const { mod, calls } = loadHandler({
    memberTeams: [{ team_id: 9 }], groupTeams: [9], existingActive: { id: 77 },
  });
  const ctx = messageCtx(DIR_LINK);
  const res = await mod.handleRouteMessage(ctx);
  assert.equal(res.reason, 'needs_confirmation');
  assert.equal(calls.assignRoute.length, 0);
  assert.match(ctx.sent[0].t, /already has an active route/i);
  // Confirmation buttons present
  const kb = ctx.sent[0].extra.reply_markup.inline_keyboard[0];
  assert.equal(kb.length, 2);
  assert.match(kb[0].callback_data, /^rc:replace:/);
  assert.match(kb[1].callback_data, /^rc:ignore:/);
});

test('confirming Replace cancels the old route and assigns the new one', async () => {
  const { mod, calls } = loadHandler({
    memberTeams: [{ team_id: 9 }], groupTeams: [9], existingActive: { id: 77 },
  });
  await mod.handleRouteMessage(messageCtx(DIR_LINK, { messageId: 42 }));
  const cb = {
    match: ['rc:replace:-100123:42', 'replace', '-100123', '42'],
    from: { id: 555, username: 'disp_alice' },
    callbackQuery: { message: { chat: { id: -100123 }, message_id: 9 } },
    async answerCbQuery() {},
    async editMessageText() {},
    telegram: { async sendMessage() { return { message_id: 1 }; } },
  };
  const res = await mod.handleConfirmationAction(cb);
  assert.equal(res.reason, 'replaced');
  assert.equal(calls.cancelActive.length, 1);
  assert.equal(calls.assignRoute.length, 1);
});

test('confirming Ignore keeps the current route and records an ignored event', async () => {
  const { mod, calls } = loadHandler({
    memberTeams: [{ team_id: 9 }], groupTeams: [9], existingActive: { id: 77 },
  });
  await mod.handleRouteMessage(messageCtx(DIR_LINK, { messageId: 42 }));
  const cb = {
    match: ['rc:ignore:-100123:42', 'ignore', '-100123', '42'],
    from: { id: 555, username: 'disp_alice' },
    callbackQuery: { message: { chat: { id: -100123 }, message_id: 9 } },
    async answerCbQuery() {},
    async editMessageText() {},
    telegram: { async sendMessage() { return { message_id: 1 }; } },
  };
  const res = await mod.handleConfirmationAction(cb);
  assert.equal(res.reason, 'ignored');
  assert.equal(calls.assignRoute.length, 0);
  assert.equal(calls.events.filter((e) => e.eventType === 'ignored').length, 1);
});

test('a non-driver group is ignored entirely', async () => {
  const { mod, calls } = loadHandler({ group: { id: 2, group_type: 'employee', active: true } });
  const res = await mod.handleRouteMessage(messageCtx(DIR_LINK));
  assert.equal(res.handled, false);
  assert.equal(calls.assignRoute.length, 0);
});

test('a message already turned into an assignment is deduped (restart-safe)', async () => {
  const { mod, calls } = loadHandler({
    memberTeams: [{ team_id: 9 }], groupTeams: [9], dedupHit: { id: 5 },
  });
  const res = await mod.handleRouteMessage(messageCtx(DIR_LINK));
  assert.equal(res.reason, 'dedup_persistent');
  assert.equal(calls.assignRoute.length, 0);
});
