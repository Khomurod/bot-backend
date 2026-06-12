const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function loadHandlersWithMocks({
  dbMock = {},
  statusSnapshotMock = {},
  configMock = {},
} = {}) {
  const handlersPath = path.resolve(__dirname, '../bot/dispatchStatusLookupHandlers.js');
  const dbPath = path.resolve(__dirname, '../database/db.js');
  const configPath = path.resolve(__dirname, '../config/config.js');
  const snapshotPath = path.resolve(__dirname, '../services/statusSnapshotDetached.js');
  const etaPath = path.resolve(__dirname, '../services/dispatchEtaUpdateService.js');
  const sessionPath = path.resolve(__dirname, '../bot/dispatchStatusLookupSession.js');
  const driverLookupPath = path.resolve(__dirname, '../services/driverStatusLookupService.js');
  const driverTitlePath = path.resolve(__dirname, '../services/driverGroupTitle.js');

  for (const p of [
    handlersPath,
    dbPath,
    configPath,
    snapshotPath,
    etaPath,
    sessionPath,
    driverLookupPath,
    driverTitlePath,
  ]) {
    delete require.cache[p];
  }

  require.cache[configPath] = {
    exports: {
      dispatchEtaTestGroupId: '-100test',
      ...configMock,
    },
  };
  require.cache[etaPath] = {
    exports: {
      sendDriverStatusSnapshot: async () => ({ success: true }),
    },
  };

  const realDetached = require('../services/statusSnapshotDetached');

  require.cache[dbPath] = {
    exports: {
      getGroupsByIds: async () => [],
      getGroupByTelegramId: async () => null,
      getAllGroups: async () => [],
      ...dbMock,
    },
  };
  require.cache[configPath] = {
    exports: {
      dispatchEtaTestGroupId: '-100test',
      ...configMock,
    },
  };
  require.cache[snapshotPath] = {
    exports: {
      ...realDetached,
      runStatusSnapshotDetached: statusSnapshotMock.runStatusSnapshotDetached
        || realDetached.runStatusSnapshotDetached,
    },
  };

  return require(handlersPath);
}

function loadDetachedWithMocks({ snapshotServiceMock = {} } = {}) {
  const detachedPath = path.resolve(__dirname, '../services/statusSnapshotDetached.js');
  const etaPath = path.resolve(__dirname, '../services/dispatchEtaUpdateService.js');
  const configPath = path.resolve(__dirname, '../config/config.js');
  delete require.cache[detachedPath];
  delete require.cache[etaPath];
  delete require.cache[configPath];

  require.cache[configPath] = {
    exports: { dispatchEtaTestGroupId: '-100test' },
  };
  require.cache[etaPath] = {
    exports: {
      sendDriverStatusSnapshot: snapshotServiceMock.sendDriverStatusSnapshot
        || (async () => ({ success: true })),
    },
  };

  return require(detachedPath);
}

test('sendStatusForCandidate returns quickly while snapshot runs in background', async () => {
  let snapshotStarted = false;
  const handlers = loadHandlersWithMocks({
    dbMock: {
      getGroupsByIds: async () => [{
        id: 71,
        group_name: 'UNIT #005 OMAR ALAWAD',
        telegram_group_id: -10071,
        active: true,
      }],
    },
    statusSnapshotMock: {
      runStatusSnapshotDetached: () => new Promise((resolve) => {
        snapshotStarted = true;
        setTimeout(() => resolve({ success: true }), 500);
      }),
    },
  });

  const replies = [];
  const ctx = {
    chat: { id: -5289094495 },
    telegram: { sendMessage: async () => {} },
    reply: async (text) => { replies.push(text); },
  };

  const startedAt = Date.now();
  await handlers.sendStatusForCandidate(ctx, { groupId: 71 });
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed < 100, `expected fast return, took ${elapsed}ms`);
  assert.equal(replies.length, 1);
  assert.equal(replies[0], 'Building status update...');
  assert.equal(snapshotStarted, true);
});

test('runStatusSnapshotDetached sends error reply when snapshot rejects', async () => {
  const messages = [];
  const detached = loadDetachedWithMocks({
    snapshotServiceMock: {
      sendDriverStatusSnapshot: async () => {
        const err = new Error('Groq API 429: Rate limit reached');
        throw err;
      },
    },
  });

  await assert.rejects(
    () => detached.runStatusSnapshotDetached({
      telegram: {
        sendMessage: async (_chatId, text) => { messages.push(text); },
      },
      driverGroup: { id: 71, group_name: 'UNIT #005 OMAR ALAWAD' },
      destinationChatId: -5289094495,
      targetMode: 'test',
      timeoutMs: 120_000,
    }),
    /Rate limit/
  );

  assert.equal(messages.length, 1);
  assert.match(messages[0], /UNIT #005 OMAR ALAWAD/);
  assert.match(messages[0], /AI rate-limited/);
});

test('runStatusSnapshotDetached hard timeout sends timed out error reply', async () => {
  const messages = [];
  const detached = loadDetachedWithMocks({
    snapshotServiceMock: {
      sendDriverStatusSnapshot: () => new Promise(() => {}),
    },
  });

  await assert.rejects(
    () => detached.runStatusSnapshotDetached({
      telegram: {
        sendMessage: async (_chatId, text) => { messages.push(text); },
      },
      driverGroup: { id: 71, group_name: 'UNIT #005 OMAR ALAWAD' },
      destinationChatId: -5289094495,
      targetMode: 'test',
      timeoutMs: 50,
    }),
    (err) => err.code === 'SNAPSHOT_TIMEOUT'
  );

  assert.equal(messages.length, 1);
  assert.match(messages[0], /timed out/);
});

test('runStatusSnapshotDetached error reply failure does not cause unhandled rejection', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);

  try {
    const detached = loadDetachedWithMocks({
      snapshotServiceMock: {
        sendDriverStatusSnapshot: async () => {
          throw new Error('snapshot boom');
        },
      },
    });

    await assert.rejects(
      () => detached.runStatusSnapshotDetached({
        telegram: {
          sendMessage: async () => {
            throw new Error('telegram down');
          },
        },
        driverGroup: { id: 71, group_name: 'UNIT #005 OMAR ALAWAD' },
        destinationChatId: -5289094495,
        targetMode: 'test',
        timeoutMs: 120_000,
      }),
      /snapshot boom/
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(unhandled.length, 0);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('withTimeout clears timer after promise resolves', async () => {
  const detached = loadDetachedWithMocks();
  const result = await detached.withTimeout(Promise.resolve('ok'), 100, 'Test');
  assert.equal(result, 'ok');
});
