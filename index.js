/**
 * Main entry point for the dispatch and feedback hub.
 */
// Fail fast on missing/malformed required configuration BEFORE any module
// side effects. This is the startup boundary for config validation — the
// config module itself never exits at import time (unit tests import it).
require('./config/config').assertRequiredConfig();

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { bot, startBot, stopBot } = require('./bot/bot');
const { startServer, stopServer } = require('./server/api');
const { startScheduler, stopScheduler } = require('./services/schedulerService');
const { startBirthdayService, stopBirthdayService } = require('./services/birthdayService');
const {
  startGroupStatusAiService,
  stopGroupStatusAiService,
} = require('./services/groupStatusAiService');
const {
  startEmployeeBirthdayWishService,
  stopEmployeeBirthdayWishService,
} = require('./services/employeeBirthdayWishService');
const {
  configureFacebookLeadTelegram,
  startFacebookWebhookWorker,
  stopFacebookWebhookWorker,
} = require('./services/facebookWebhookService');
const {
  configureDispatchEtaTelegram,
  startDispatchEtaScheduler,
  stopDispatchEtaScheduler,
} = require('./services/dispatchEtaUpdateService');
const {
  startMileageBonusService,
  stopMileageBonusService,
} = require('./services/mileageBonusService');
const {
  startDatatruckDocumentService,
  stopDatatruckDocumentService,
} = require('./services/datatruckDocumentService');
const {
  startRaiseApprovalService,
  stopRaiseApprovalService,
} = require('./services/raiseApprovalService');
const {
  startFuelStopAlertService,
  stopFuelStopAlertService,
} = require('./services/fuelStopAlertService');
const {
  startRecruiterCallSyncService,
  stopRecruiterCallSyncService,
} = require('./services/recruiterCallSyncService');
const {
  startRoadBonusNotifierService,
  stopRoadBonusNotifierService,
} = require('./services/roadBonusNotifierService');
const {
  startHomeTimeReminderService,
  stopHomeTimeReminderService,
} = require('./services/homeTimeReminderService');
const {
  startRouteControlService,
  stopRouteControlService,
} = require('./services/routeControlService');
const {
  startDuplicateUnitCheckService,
  stopDuplicateUnitCheckService,
} = require('./services/duplicateUnitCheckService');
const {
  startTrailerNotificationService,
  stopTrailerNotificationService,
} = require('./services/trailerNotificationService');
const {
  startMemoryWatchdog,
  stopMemoryWatchdog,
} = require('./services/memoryWatchdog');
const db = require('./database/db');
const config = require('./config/config');

const DB_DRAIN_TIMEOUT_MS = 5000;
const CHILD_STOP_TIMEOUT_MS = 10_000;
const CHILD_RESTART_BASE_MS = 2_000;
const CHILD_RESTART_MAX_MS = 60_000;

// Circuit breaker: if a child crashes MAX_RAPID_CRASHES times within
// RAPID_CRASH_WINDOW_MS, stop restarting it permanently. This prevents
// config errors (e.g. bad tokens) from creating an infinite restart loop
// that eats all available memory and OOM-kills the entire instance.
const MAX_RAPID_CRASHES = 5;
const RAPID_CRASH_WINDOW_MS = 3 * 60_000; // 3 minutes

// NOTE: The Samsara safety-event poller used to be spawned here as a Node child
// process. It has been moved out of this repository entirely and now runs from
// its own repository (github.com/Khomurod/samsara-integration) as a separate
// Render service. Removing the child freed the memory that was causing OOM
// kills on the free instance. The two services still cooperate through the
// shared PostgreSQL database (the `groups` table) and the shared Telegram bot
// tokens — no in-process link is required.
let leadsProcess = null;
let leadsRestartTimer = null;
let leadsRestartDelayMs = CHILD_RESTART_BASE_MS;
const leadsCrashTimestamps = [];
let leadsCircuitOpen = false;
let isShuttingDown = false;

function isCircuitBroken(timestamps, label) {
  const now = Date.now();
  // Remove old entries outside the window
  while (timestamps.length && timestamps[0] < now - RAPID_CRASH_WINDOW_MS) {
    timestamps.shift();
  }
  timestamps.push(now);
  if (timestamps.length >= MAX_RAPID_CRASHES) {
    console.error(
      `[${label}] CIRCUIT BREAKER OPEN: ${timestamps.length} crashes in ${Math.round(RAPID_CRASH_WINDOW_MS / 1000)}s. `
      + `Child will NOT be restarted. Fix the root cause and redeploy.`
    );
    return true;
  }
  return false;
}

function isEnabled(name, defaultValue = true) {
  const value = process.env[name];
  if (value === undefined || value === null || value === '') return defaultValue;
  return value !== 'false';
}

function assertDistinctTelegramPollingTokens() {
  const enabledTokens = [
    {
      service: 'feedback hub',
      enabled: true,
      envName: 'BOT_TOKEN',
      token: String(process.env.BOT_TOKEN || '').trim(),
    },
    {
      service: 'leads bot',
      enabled: isEnabled('ENABLE_LEADS_BOT', true),
      envName: 'TELEGRAM_BOT_TOKEN',
      token: String(process.env.TELEGRAM_BOT_TOKEN || '').trim(),
    },
  ].filter(({ enabled }) => enabled);

  for (const entry of enabledTokens) {
    if (!entry.token) {
      throw new Error(`${entry.envName} is required while the ${entry.service} is enabled`);
    }
  }

  for (let i = 0; i < enabledTokens.length; i += 1) {
    for (let j = i + 1; j < enabledTokens.length; j += 1) {
      if (enabledTokens[i].token === enabledTokens[j].token) {
        throw new Error(
          `Telegram polling token conflict: ${enabledTokens[i].envName} and `
          + `${enabledTokens[j].envName} must be different`
        );
      }
    }
  }
}

function writeChildOutput(prefix, stream, writer) {
  if (!stream) return;
  stream.on('data', (chunk) => {
    const text = String(chunk).trimEnd();
    if (text) writer(`[${prefix}] ${text}`);
  });
}

function scheduleLeadsRestart(reason) {
  if (isShuttingDown || !isEnabled('ENABLE_LEADS_BOT', true) || leadsRestartTimer || leadsCircuitOpen) return;
  if (isCircuitBroken(leadsCrashTimestamps, 'LEADS')) {
    leadsCircuitOpen = true;
    return;
  }
  const delay = leadsRestartDelayMs;
  leadsRestartDelayMs = Math.min(leadsRestartDelayMs * 2, CHILD_RESTART_MAX_MS);
  console.warn(`[LEADS] Restart scheduled in ${delay}ms (${reason})`);
  leadsRestartTimer = setTimeout(() => {
    leadsRestartTimer = null;
    startLeadsBot();
  }, delay);
  leadsRestartTimer.unref?.();
}

function startLeadsBot() {
  console.log('[LEADS] Disabled in AI Studio (no Python runtime)');
}

function killWithEscalation(child, label) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) {
      resolve();
      return;
    }

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      resolve();
    };
    const forceTimer = setTimeout(() => {
      console.warn(`[${label}] SIGTERM grace period expired; sending SIGKILL`);
      try {
        child.kill('SIGKILL');
      } catch (error) {
        console.error(`[${label}] SIGKILL failed:`, error);
      }
      finish();
    }, CHILD_STOP_TIMEOUT_MS);
    forceTimer.unref?.();

    child.once('exit', finish);
    try {
      child.kill('SIGTERM');
    } catch (error) {
      console.error(`[${label}] SIGTERM failed:`, error);
      finish();
    }
  });
}

function isTelegramPollingConflict(err) {
  const description = err?.response?.description || err?.message || '';
  return err?.response?.error_code === 409
    || description.includes('terminated by other getUpdates request');
}

async function drainDatabasePool() {
  await Promise.race([
    db.pool.end(),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('pool.end() timeout')),
      DB_DRAIN_TIMEOUT_MS,
    )),
  ]);
}

async function shutdownAll(signal = 'SIGTERM', exitCode = 0) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  if (leadsRestartTimer) clearTimeout(leadsRestartTimer);

  console.log(`[SHUTDOWN] Graceful shutdown initiated (${signal})...`);

  try { stopScheduler(); } catch (err) { console.error('[SHUTDOWN] stopScheduler failed:', err.message); }
  try { stopDispatchEtaScheduler(); } catch (err) { console.error('[SHUTDOWN] stopDispatchEtaScheduler failed:', err.message); }
  try { stopBirthdayService(); } catch (err) { console.error('[SHUTDOWN] stopBirthdayService failed:', err.message); }
  try { stopEmployeeBirthdayWishService(); } catch (err) { console.error('[SHUTDOWN] stopEmployeeBirthdayWishService failed:', err.message); }
  try { stopGroupStatusAiService(); } catch (err) { console.error('[SHUTDOWN] stopGroupStatusAiService failed:', err.message); }
  try { stopMileageBonusService(); } catch (err) { console.error('[SHUTDOWN] stopMileageBonusService failed:', err.message); }
  try { stopDatatruckDocumentService(); } catch (err) { console.error('[SHUTDOWN] stopDatatruckDocumentService failed:', err.message); }
  try { stopRaiseApprovalService(); } catch (err) { console.error('[SHUTDOWN] stopRaiseApprovalService failed:', err.message); }
  try { stopFuelStopAlertService(); } catch (err) { console.error('[SHUTDOWN] stopFuelStopAlertService failed:', err.message); }
  try { stopRecruiterCallSyncService(); } catch (err) { console.error('[SHUTDOWN] stopRecruiterCallSyncService failed:', err.message); }
  try { stopRoadBonusNotifierService(); } catch (err) { console.error('[SHUTDOWN] stopRoadBonusNotifierService failed:', err.message); }
  try { stopHomeTimeReminderService(); } catch (err) { console.error('[SHUTDOWN] stopHomeTimeReminderService failed:', err.message); }
  try { stopRouteControlService(); } catch (err) { console.error('[SHUTDOWN] stopRouteControlService failed:', err.message); }
  try { stopDuplicateUnitCheckService(); } catch (err) { console.error('[SHUTDOWN] stopDuplicateUnitCheckService failed:', err.message); }
  try { stopTrailerNotificationService(); } catch (err) { console.error('[SHUTDOWN] stopTrailerNotificationService failed:', err.message); }
  try { stopMemoryWatchdog(); } catch (err) { console.error('[SHUTDOWN] stopMemoryWatchdog failed:', err.message); }

  await Promise.allSettled([
    stopFacebookWebhookWorker(),
    Promise.resolve().then(() => stopBot(signal)),
    stopServer(),
    killWithEscalation(leadsProcess, 'LEADS'),
  ]);

  try {
    await drainDatabasePool();
    console.log('[SHUTDOWN] Database pool drained.');
  } catch (err) {
    console.error('[SHUTDOWN] Error draining pool:', err.message);
  }

  process.exit(exitCode);
}

async function start() {
  console.log('===========================================');
  console.log('  Telegram Driver Feedback System');
  console.log('===========================================');

  assertDistinctTelegramPollingTokens();
  await db.initializeDatabase();

  configureDispatchEtaTelegram(bot.telegram);
  const { getLeadsTelegram } = require('./services/leadsTelegramClient');
  configureFacebookLeadTelegram(getLeadsTelegram());
  console.log('[BOOT] Facebook lead Telegram delivery uses TELEGRAM_BOT_TOKEN (WenzeLeadBots).');

  startServer();
  await startBot();
  startScheduler();
  startDispatchEtaScheduler();
  startBirthdayService();
  startEmployeeBirthdayWishService();
  startGroupStatusAiService();
  startMileageBonusService();
  startDatatruckDocumentService();
  startRaiseApprovalService();
  startFuelStopAlertService(bot.telegram);
  startRecruiterCallSyncService();
  startRoadBonusNotifierService(bot.telegram);
  startHomeTimeReminderService(bot.telegram);
  startRouteControlService(bot.telegram);
  startDuplicateUnitCheckService();
  if (config.trailerDepartmentEnabled) startTrailerNotificationService(bot.telegram);
  await startFacebookWebhookWorker();
  startLeadsBot();
  startMemoryWatchdog();
}

process.once('SIGINT', () => {
  void shutdownAll('SIGINT');
});
process.once('SIGTERM', () => {
  void shutdownAll('SIGTERM');
});

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err);
  void shutdownAll('uncaughtException', 1);
});

process.on('unhandledRejection', (reason) => {
  if (isTelegramPollingConflict(reason)) {
    console.warn('[BOT] Polling conflict detected. Waiting for retry loop to reclaim the token.');
    return;
  }
  console.error('[FATAL] Unhandled Rejection:', reason);
  void shutdownAll('unhandledRejection', 1);
});

start().catch((err) => {
  console.error('[BOOT] Fatal startup error:', err);
  process.exit(1);
});
