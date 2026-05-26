const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  isVideoRetryEnabled,
  getVideoRetryDelayMs,
  shouldDeferVideoRetry,
  patchAlertVideoUrls,
  enqueueFormattedAlert,
  scheduleVideoRetryDelivery,
  DEFAULT_DELAY_MS,
} = require('../samsara-integration/src/videoRetryDelivery');

const origRetryEnabled = process.env.SAMSARA_VIDEO_RETRY_ENABLED;
const origRetryDelay = process.env.SAMSARA_VIDEO_RETRY_DELAY_MS;

test.after(() => {
  if (origRetryEnabled === undefined) delete process.env.SAMSARA_VIDEO_RETRY_ENABLED;
  else process.env.SAMSARA_VIDEO_RETRY_ENABLED = origRetryEnabled;
  if (origRetryDelay === undefined) delete process.env.SAMSARA_VIDEO_RETRY_DELAY_MS;
  else process.env.SAMSARA_VIDEO_RETRY_DELAY_MS = origRetryDelay;
});

test('shouldDeferVideoRetry is false when videoUrl is set', () => {
  delete process.env.SAMSARA_VIDEO_RETRY_ENABLED;
  assert.equal(shouldDeferVideoRetry({ videoUrl: 'https://x.mp4' }, 'evt-1'), false);
});

test('shouldDeferVideoRetry is false when eventId is missing', () => {
  delete process.env.SAMSARA_VIDEO_RETRY_ENABLED;
  assert.equal(shouldDeferVideoRetry({ text: 'alert' }, null), false);
});

test('shouldDeferVideoRetry is true when no URLs and eventId present', () => {
  delete process.env.SAMSARA_VIDEO_RETRY_ENABLED;
  assert.equal(shouldDeferVideoRetry({ text: 'alert' }, 'evt-1'), true);
});

test('shouldDeferVideoRetry is false when SAMSARA_VIDEO_RETRY_ENABLED=false', () => {
  process.env.SAMSARA_VIDEO_RETRY_ENABLED = 'false';
  assert.equal(shouldDeferVideoRetry({ text: 'alert' }, 'evt-1'), false);
});

test('getVideoRetryDelayMs defaults and clamps', () => {
  delete process.env.SAMSARA_VIDEO_RETRY_DELAY_MS;
  assert.equal(getVideoRetryDelayMs(), DEFAULT_DELAY_MS);
  process.env.SAMSARA_VIDEO_RETRY_DELAY_MS = '10000';
  assert.equal(getVideoRetryDelayMs(), 30_000);
  process.env.SAMSARA_VIDEO_RETRY_DELAY_MS = '999999';
  assert.equal(getVideoRetryDelayMs(), 180_000);
  delete process.env.SAMSARA_VIDEO_RETRY_DELAY_MS;
});

test('patchAlertVideoUrls sets forward and inward URLs', () => {
  const alert = { text: 'x' };
  patchAlertVideoUrls(alert, {
    forwardUrl: 'https://forward.mp4',
    inwardUrl: 'https://inward.mp4',
  });
  assert.equal(alert.videoUrl, 'https://forward.mp4');
  assert.equal(alert.inwardVideoUrl, 'https://inward.mp4');
});

test('enqueueFormattedAlert calls queueAlert immediately when video present', () => {
  delete process.env.SAMSARA_VIDEO_RETRY_ENABLED;
  let called = 0;
  const alert = { text: 'x', videoUrl: 'https://v.mp4' };
  enqueueFormattedAlert(alert, { id: 'evt-1' }, () => { called += 1; });
  assert.equal(called, 1);
  assert.equal(alert.samsaraEventId, 'evt-1');
});

test('enqueueFormattedAlert defers queueAlert until timer fires', async () => {
  delete process.env.SAMSARA_VIDEO_RETRY_ENABLED;
  let queued = 0;
  const alert = { text: 'x' };
  let timerFn = null;

  enqueueFormattedAlert(
    alert,
    { id: 'evt-defer' },
    () => { queued += 1; },
    {
      delayMs: 0,
      setTimer: (fn) => {
        timerFn = fn;
      },
      refetchFn: async () => ({
        forwardUrl: 'https://retry.mp4',
        inwardUrl: null,
      }),
    },
  );

  assert.equal(queued, 0);
  assert.equal(timerFn != null, true);
  await timerFn();
  assert.equal(queued, 1);
  assert.equal(alert.videoUrl, 'https://retry.mp4');
});

test('scheduleVideoRetryDelivery still queues on refetch failure', async () => {
  delete process.env.SAMSARA_VIDEO_RETRY_ENABLED;
  let queued = 0;
  const alert = { text: 'x' };
  let timerFn = null;

  scheduleVideoRetryDelivery({
    formattedAlert: alert,
    eventId: 'evt-fail',
    queueAlert: () => { queued += 1; },
    delayMs: 0,
    setTimer: (fn) => { timerFn = fn; },
    refetchFn: async () => { throw new Error('API down'); },
  });

  await timerFn();
  assert.equal(queued, 1);
  assert.equal(alert.videoUrl, undefined);
});

test('isVideoRetryEnabled defaults to true', () => {
  delete process.env.SAMSARA_VIDEO_RETRY_ENABLED;
  assert.equal(isVideoRetryEnabled(), true);
});
