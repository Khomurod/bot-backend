/**
 * Detached /status snapshot runner — returns immediately from Telegraf handlers
 * while heavy work continues in the background with a hard timeout and user-facing errors.
 */
const { sendDriverStatusSnapshot } = require('./dispatchEtaUpdateService');

const DEFAULT_SNAPSHOT_TIMEOUT_MS = 120_000;

function withTimeout(promise, ms, label = 'Operation') {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${ms}ms`);
      err.code = 'SNAPSHOT_TIMEOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function shortSnapshotFailureReason(err) {
  const msg = String(err?.message || err || '');
  if (err?.code === 'SNAPSHOT_TIMEOUT' || /timed out/i.test(msg)) {
    return 'timed out';
  }
  if (/rate limit|429|too many requests/i.test(msg)) {
    return 'AI rate-limited';
  }
  return 'unexpected error';
}

async function runStatusSnapshotDetached({
  telegram,
  driverGroup,
  destinationChatId,
  targetMode = 'test',
  interactive = true,
  timeoutMs = DEFAULT_SNAPSHOT_TIMEOUT_MS,
}) {
  const groupName = String(driverGroup?.group_name || '').trim() || `#${driverGroup?.id}`;
  try {
    await withTimeout(
      sendDriverStatusSnapshot({
        telegram,
        driverGroup,
        destinationChatId,
        targetMode,
        interactive,
      }),
      timeoutMs,
      'Status snapshot'
    );
    return { success: true };
  } catch (err) {
    console.error(`[DISPATCH-STATUS] Snapshot failed for ${groupName}:`, err.message);
    const reason = shortSnapshotFailureReason(err);
    await telegram.sendMessage(
      destinationChatId,
      `Couldn't build the status update for ${groupName} right now (${reason}). Try again in a minute.`
    ).catch(() => {});
    throw err;
  }
}

module.exports = {
  DEFAULT_SNAPSHOT_TIMEOUT_MS,
  withTimeout,
  shortSnapshotFailureReason,
  runStatusSnapshotDetached,
};
