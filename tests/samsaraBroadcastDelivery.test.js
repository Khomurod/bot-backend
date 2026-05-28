const { test } = require('node:test');
const assert = require('node:assert/strict');

const { sendDriverGroupAlert } = require('../samsara-integration/src/driverGroupDelivery');
const poller = require('../samsara-integration/src/poller');

test.afterEach(() => {
  poller._forTest.resetDeliveryStateForTest();
  poller.setBroadcastFn(null);
});

test('delivery state commits only after successful broadcast', async () => {
  let broadcastCalls = 0;
  poller.setBroadcastFn(async () => {
    broadcastCalls += 1;
  });

  poller._forTest.enqueueAlertForTest({ text: 'alert', samsaraEventId: 'evt-success-1' });
  const result = await poller._forTest.processNextQueuedAlertForTest();

  assert.equal(result.delivered, true);
  assert.equal(broadcastCalls, 1);
  assert.ok(poller._forTest.getSeenIds().has('evt-success-1'));
  assert.equal(poller._forTest.getPendingDeliveryIds().size, 0);
});

test('failed broadcast does not commit delivery state', async () => {
  poller.setBroadcastFn(async () => {
    throw new Error('simulated driver failure');
  });

  poller._forTest.enqueueAlertForTest({ text: 'alert', samsaraEventId: 'evt-fail-1' });
  const result = await poller._forTest.processNextQueuedAlertForTest();

  assert.equal(result.delivered, false);
  assert.equal(poller._forTest.getSeenIds().has('evt-fail-1'), false);
  assert.equal(poller._forTest.getPendingDeliveryIds().size, 0);
});

test('sendDriverGroupAlert falls back to text when sendVideo fails', async () => {
  const calls = [];
  const driverBot = {
    async sendVideo() {
      calls.push('sendVideo');
      throw new Error('video rejected');
    },
    async sendMessage(_groupId, caption) {
      calls.push('sendMessage');
      assert.match(caption, /safe/i);
      return { message_id: 1 };
    },
    async sendMediaGroup() {
      calls.push('sendMediaGroup');
      throw new Error('not used');
    },
  };

  await sendDriverGroupAlert(driverBot, '-100123', {
    caption: '<b>Hey</b> — drive safe out there!',
    videoUrl: 'https://cdn.example.com/forward.mp4',
    inwardVideoUrl: null,
    getVideoBuffer: async () => Buffer.from('fake'),
  });

  assert.deepEqual(calls, ['sendVideo', 'sendMessage']);
});

test('sendDriverGroupAlert sends dual camera when both URLs present', async () => {
  const calls = [];
  const driverBot = {
    async sendMediaGroup() {
      calls.push('sendMediaGroup');
      return [{ message_id: 1 }, { message_id: 2 }];
    },
    async sendVideo() {
      calls.push('sendVideo');
    },
    async sendMessage() {
      calls.push('sendMessage');
    },
  };

  await sendDriverGroupAlert(driverBot, '-100123', {
    caption: 'test',
    videoUrl: 'https://cdn.example.com/f.mp4',
    inwardVideoUrl: 'https://cdn.example.com/i.mp4',
    getVideoBuffer: async () => Buffer.from('fake'),
    log: { error: () => {} },
  });

  assert.deepEqual(calls, ['sendMediaGroup']);
});
