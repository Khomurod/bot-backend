const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function loadHandlersWithPeerMock(handleImpl) {
  const handlersPath = path.resolve(__dirname, '../bot/datatruckPeerHandlers.js');
  const servicePath = path.resolve(__dirname, '../services/datatruckPeerBotService.js');

  delete require.cache[handlersPath];
  delete require.cache[servicePath];

  require.cache[servicePath] = {
    exports: {
      handleDatatruckPeerMessage: handleImpl,
    },
  };

  return require(handlersPath);
}

function captureMessageMiddleware(bot) {
  let middleware = null;
  bot.on = (event, fn) => {
    if (event === 'message') middleware = fn;
  };
  return () => middleware;
}

test('registerDatatruckPeerHandlers logs skipped reason for bot senders', async () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => {
    logs.push(args.join(' '));
  };

  try {
    const { registerDatatruckPeerHandlers } = loadHandlersWithPeerMock(async () => ({
      handled: false,
      reason: 'not_active_driver_group',
    }));

    const bot = { on: () => {} };
    const getMiddleware = captureMessageMiddleware(bot);
    registerDatatruckPeerHandlers(bot);
    const middleware = getMiddleware();
    assert.ok(typeof middleware === 'function');

    let nextCalled = false;
    await middleware({
      from: { is_bot: true, username: 'datatruck_driver_bot' },
      chat: { id: -100111, type: 'supergroup' },
      message: { text: 'Unknown command. Please use a valid command.' },
    }, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(logs.length, 2);
    assert.match(logs[0], /Peer bot handlers registered/);
    assert.match(logs[1], /Skipped bot message: reason=not_active_driver_group/);
    assert.match(logs[1], /from=@datatruck_driver_bot/);
    assert.match(logs[1], /chat=-100111/);
    assert.match(logs[1], /Unknown command/);
  } finally {
    console.log = originalLog;
    delete require.cache[path.resolve(__dirname, '../bot/datatruckPeerHandlers.js')];
    delete require.cache[path.resolve(__dirname, '../services/datatruckPeerBotService.js')];
  }
});

test('registerDatatruckPeerHandlers does not log skipped reason for human senders', async () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => {
    logs.push(args.join(' '));
  };

  try {
    const { registerDatatruckPeerHandlers } = loadHandlersWithPeerMock(async () => ({
      handled: false,
      reason: 'not_peer_bot',
    }));

    const bot = { on: () => {} };
    const getMiddleware = captureMessageMiddleware(bot);
    registerDatatruckPeerHandlers(bot);
    const middleware = getMiddleware();

    await middleware({
      from: { is_bot: false, username: 'human_driver' },
      chat: { id: -100111, type: 'supergroup' },
      message: { text: '/location' },
    }, () => {});

    assert.equal(logs.length, 1);
    assert.match(logs[0], /Peer bot handlers registered/);
  } finally {
    console.log = originalLog;
    delete require.cache[path.resolve(__dirname, '../bot/datatruckPeerHandlers.js')];
    delete require.cache[path.resolve(__dirname, '../services/datatruckPeerBotService.js')];
  }
});

test('registerDatatruckPeerHandlers does not log when bot message is handled', async () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => {
    logs.push(args.join(' '));
  };

  try {
    const { registerDatatruckPeerHandlers } = loadHandlersWithPeerMock(async () => ({
      handled: true,
      action: 'banter',
    }));

    const bot = { on: () => {} };
    const getMiddleware = captureMessageMiddleware(bot);
    registerDatatruckPeerHandlers(bot);
    const middleware = getMiddleware();

    await middleware({
      from: { is_bot: true, username: 'datatruck_driver_bot' },
      chat: { id: -100111, type: 'supergroup' },
      message: { text: 'Unknown command.' },
    }, () => {});

    assert.equal(logs.length, 1);
    assert.match(logs[0], /Peer bot handlers registered/);
  } finally {
    console.log = originalLog;
    delete require.cache[path.resolve(__dirname, '../bot/datatruckPeerHandlers.js')];
    delete require.cache[path.resolve(__dirname, '../services/datatruckPeerBotService.js')];
  }
});
