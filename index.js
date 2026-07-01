/**
 * Main entry point for the dispatch and feedback hub.
 */
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
  startHomeTimeBonusScheduler,
  stopHomeTimeBonusScheduler,
} = require('./services/homeTimeService');
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
  configureDriverLocationTelegram,
  startDriverLocationMonitorService,
  stopDriverLocationMonitorService,
} = require('./services/driverLocationMonitorService');
const db = require('./database/db');

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
  if (
    isShuttingDown
    || !isEnabled('ENABLE_LEADS_BOT', true)
    || (leadsProcess && leadsProcess.exitCode === null)
  ) {
    return;
  }

  const leadsDir = path.join(__dirname, 'leads-bot');
  const scriptPath = path.join(leadsDir, 'main.py');
  if (!fs.existsSync(scriptPath)) {
    console.error(`[LEADS] Missing entry point: ${scriptPath}`);
    scheduleLeadsRestart('entry point missing');
    return;
  }

  const pythonBin = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
  const rootPort = Number.parseInt(process.env.PORT || '3001', 10);
  const leadsPort = Number.parseInt(process.env.LEADS_BOT_PORT || '8000', 10);

  try {
    const child = spawn(pythonBin, ['-u', scriptPath], {
      cwd: leadsDir,
      env: {
        ...process.env,
        PORT: String(leadsPort),
        LOCAL_API_BASE_URL: process.env.LOCAL_API_BASE_URL || `http://127.0.0.1:${rootPort}`,
        PYTHONUNBUFFERED: '1',
        MALLOC_ARENA_MAX: process.env.MALLOC_ARENA_MAX || '2',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    leadsProcess = child;
    console.log(`[LEADS] Started PID ${child.pid}`);
    writeChildOutput('LEADS', child.stdout, console.log);
    writeChildOutput('LEADS', child.stderr, console.error);

    const stableTimer = setTimeout(() => {
      if (leadsProcess === child && child.exitCode === null) {
        leadsRestartDelayMs = CHILD_RESTART_BASE_MS;
      }
    }, 30_000);
    stableTimer.unref?.();

    child.once('error', (error) => {
      clearTimeout(stableTimer);
      if (leadsProcess === child) leadsProcess = null;
      console.error('[LEADS] Process error:', error);
      scheduleLeadsRestart(error.message);
    });

    child.once('exit', (code, signal) => {
      clearTimeout(stableTimer);
      if (leadsProcess === child) leadsProcess = null;
      if (isShuttingDown) return;
      if (code === 78) {
        console.error('[LEADS] Exited with EX_CONFIG (78) — permanent config error, will NOT restart.');
        leadsCircuitOpen = true;
        return;
      }
      scheduleLeadsRestart(`exit code=${code} signal=${signal || 'none'}`);
    });
  } catch (error) {
    leadsProcess = null;
    console.error('[LEADS] Failed to spawn:', error);
    scheduleLeadsRestart(error.message);
  }
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
  try { stopHomeTimeBonusScheduler(); } catch (err) { console.error('[SHUTDOWN] stopHomeTimeBonusScheduler failed:', err.message); }
  try { stopDatatruckDocumentService(); } catch (err) { console.error('[SHUTDOWN] stopDatatruckDocumentService failed:', err.message); }
  try { stopRaiseApprovalService(); } catch (err) { console.error('[SHUTDOWN] stopRaiseApprovalService failed:', err.message); }
  try { stopFuelStopAlertService(); } catch (err) { console.error('[SHUTDOWN] stopFuelStopAlertService failed:', err.message); }
  try { stopDriverLocationMonitorService(); } catch (err) { console.error('[SHUTDOWN] stopDriverLocationMonitorService failed:', err.message); }

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
  configureDriverLocationTelegram(bot.telegram);
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
  startHomeTimeBonusScheduler(bot.telegram);
  startDatatruckDocumentService();
  startRaiseApprovalService();
  startFuelStopAlertService(bot.telegram);
  startDriverLocationMonitorService(bot.telegram);
  await startFacebookWebhookWorker();
  startLeadsBot();
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
