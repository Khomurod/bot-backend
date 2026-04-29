/**
 * Main entry point: starts the Telegram bot, Express API server,
 * and optional child services.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { bot, startBot, stopBot } = require('./bot/bot');
const { startServer, stopServer } = require('./server/api');
const { startScheduler, stopScheduler } = require('./services/schedulerService');
const { startWeeklyReporter, stopWeeklyReporter } = require('./services/weeklyReportService');
const { startBirthdayService, stopBirthdayService } = require('./services/birthdayService');
const { startBackgroundAnnotator } = require('./services/aiAnnotationService');
const {
  configureDispatchEtaTelegram,
  startDispatchEtaScheduler,
  stopDispatchEtaScheduler,
} = require('./services/dispatchEtaUpdateService');
const db = require('./database/db');

const MAX_RESTART_DELAY = 60000;
const MAX_CHILD_RESTARTS = 6;
const CHILD_SHUTDOWN_TIMEOUT_MS = 8000;
const DB_DRAIN_TIMEOUT_MS = 5000;

function isTelegramPollingConflict(err) {
  const description = err?.response?.description || err?.message || '';
  return err?.response?.error_code === 409
    || description.includes('terminated by other getUpdates request');
}

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err.message);
  console.error(err.stack);
  setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason) => {
  if (isTelegramPollingConflict(reason)) {
    console.warn('[BOT] Polling conflict detected. Waiting for retry loop to reclaim the token.');
    return;
  }
  console.error('[FATAL] Unhandled Rejection:', reason);
});

// Child process state
let leadsProcess = null;
let leadsStopping = false;
let leadsRestartDelay = 5000;
let leadsRestartCount = 0;
let leadsFatalDependencyError = false;

let samsaraProcess = null;
let samsaraStopping = false;
let samsaraRestartDelay = 5000;
let samsaraRestartCount = 0;
let samsaraFatalDependencyError = false;

function scheduleLeadsRestart(reason) {
  if (leadsStopping || leadsFatalDependencyError) return;
  if (leadsRestartCount >= MAX_CHILD_RESTARTS) {
    console.error('[LEADS-BOT] Restart limit reached. Auto-restarts disabled.');
    return;
  }
  leadsRestartCount += 1;
  console.error(`[LEADS-BOT] ${reason}. Restarting in ${leadsRestartDelay / 1000}s...`);
  setTimeout(startLeadsBot, leadsRestartDelay);
  leadsRestartDelay = Math.min(leadsRestartDelay * 2, MAX_RESTART_DELAY);
}

function scheduleSamsaraRestart(reason) {
  if (samsaraStopping || samsaraFatalDependencyError) return;
  if (samsaraRestartCount >= MAX_CHILD_RESTARTS) {
    console.error('[SAMSARA-BOT] Restart limit reached. Auto-restarts disabled.');
    return;
  }
  samsaraRestartCount += 1;
  console.error(`[SAMSARA-BOT] ${reason}. Restarting in ${samsaraRestartDelay / 1000}s...`);
  setTimeout(startSamsaraBot, samsaraRestartDelay);
  samsaraRestartDelay = Math.min(samsaraRestartDelay * 2, MAX_RESTART_DELAY);
}

function startLeadsBot() {
  if (process.env.ENABLE_LEADS_BOT === 'false') {
    console.log('[LEADS-BOT] Disabled via ENABLE_LEADS_BOT=false.');
    return;
  }
  if (leadsStopping || leadsFatalDependencyError) return;

  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
  const scriptPath = path.join(__dirname, 'leads-bot', 'main.py');
  if (!fs.existsSync(scriptPath)) {
    console.warn(`[LEADS-BOT] Script not found at ${scriptPath}; child process will not start.`);
    leadsFatalDependencyError = true;
    return;
  }

  console.log('[LEADS-BOT] Starting Python process...');
  leadsProcess = spawn(pythonCmd, [scriptPath], {
    cwd: path.join(__dirname, 'leads-bot'),
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  leadsProcess.stdout.on('data', (data) => {
    const lines = data.toString().trim().split('\n');
    lines.forEach((line) => {
      if (line) console.log(`[LEADS-BOT] ${line}`);
    });
  });

  leadsProcess.stderr.on('data', (data) => {
    const lines = data.toString().trim().split('\n');
    lines.forEach((line) => {
      if (line.includes("No module named 'uvicorn'")) {
        leadsFatalDependencyError = true;
      }
      if (line) console.log(`[LEADS-BOT] ${line}`);
    });
  });

  leadsProcess.on('exit', (code) => {
    if (leadsStopping) {
      console.log('[LEADS-BOT] Process stopped.');
      return;
    }
    if (leadsFatalDependencyError) {
      console.error('[LEADS-BOT] Missing dependency detected. Auto-restarts disabled until next deploy.');
      return;
    }
    scheduleLeadsRestart(`Process exited with code ${code}`);
  });

  leadsProcess.on('error', (err) => {
    console.error(`[LEADS-BOT] Failed to start: ${err.message}`);
    scheduleLeadsRestart('Failed to start');
  });

  setTimeout(() => {
    if (leadsProcess && !leadsProcess.killed && leadsProcess.exitCode === null) {
      leadsRestartDelay = 5000;
      leadsRestartCount = 0;
    }
  }, 10000);
}

function startSamsaraBot() {
  if (process.env.ENABLE_SAMSARA_BOT === 'false') {
    console.log('[SAMSARA-BOT] Disabled via ENABLE_SAMSARA_BOT=false.');
    return;
  }
  if (samsaraStopping || samsaraFatalDependencyError) return;

  const entryPath = path.join(__dirname, 'samsara-integration', 'index.js');
  if (!fs.existsSync(entryPath)) {
    console.warn(`[SAMSARA-BOT] Script not found at ${entryPath}; child process will not start.`);
    samsaraFatalDependencyError = true;
    return;
  }

  console.log('[SAMSARA-BOT] Starting Node process...');
  samsaraProcess = spawn('node', ['index.js'], {
    cwd: path.join(__dirname, 'samsara-integration'),
    env: {
      ...process.env,
      TELEGRAM_BOT_TOKEN: process.env.SAMSARA_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN,
      SAMSARA_API_KEY: process.env.SAMSARA_API_KEY,
      PORT: process.env.SAMSARA_PORT || '3002',
      WEBHOOK_PORT: process.env.SAMSARA_PORT || '3002',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  samsaraProcess.stdout.on('data', (data) => {
    const lines = data.toString().trim().split('\n');
    lines.forEach((line) => {
      if (line) console.log(`[SAMSARA-BOT] ${line}`);
    });
  });

  samsaraProcess.stderr.on('data', (data) => {
    const lines = data.toString().trim().split('\n');
    lines.forEach((line) => {
      if (line.includes("Cannot find module 'node-telegram-bot-api'")) {
        samsaraFatalDependencyError = true;
      }
      if (line) console.error(`[SAMSARA-BOT] ${line}`);
    });
  });

  samsaraProcess.on('exit', (code) => {
    if (samsaraStopping) {
      console.log('[SAMSARA-BOT] Process stopped.');
      return;
    }
    if (samsaraFatalDependencyError) {
      console.error('[SAMSARA-BOT] Missing dependency detected. Auto-restarts disabled until next deploy.');
      return;
    }
    scheduleSamsaraRestart(`Process exited with code ${code}`);
  });

  samsaraProcess.on('error', (err) => {
    console.error(`[SAMSARA-BOT] Failed to start: ${err.message}`);
    scheduleSamsaraRestart('Failed to start');
  });

  setTimeout(() => {
    if (samsaraProcess && !samsaraProcess.killed && samsaraProcess.exitCode === null) {
      samsaraRestartDelay = 5000;
      samsaraRestartCount = 0;
    }
  }, 10000);
}

function killWithEscalation(proc, label) {
  if (!proc || proc.killed || proc.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      resolve();
    };

    const timer = setTimeout(() => {
      if (proc && !proc.killed && proc.exitCode === null) {
        console.warn(`[SHUTDOWN] ${label} did not exit in time; sending SIGKILL.`);
        try { proc.kill('SIGKILL'); } catch { /* noop */ }
      }
      done();
    }, CHILD_SHUTDOWN_TIMEOUT_MS);

    proc.once('exit', () => {
      clearTimeout(timer);
      done();
    });

    try { proc.kill('SIGTERM'); } catch { /* noop */ }
  });
}

let isShuttingDown = false;
async function shutdownAll(signal = 'SIGTERM') {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[SHUTDOWN] Graceful shutdown initiated (${signal})...`);

  try { stopScheduler(); } catch (err) { console.error('[SHUTDOWN] stopScheduler failed:', err.message); }
  try { stopDispatchEtaScheduler(); } catch (err) { console.error('[SHUTDOWN] stopDispatchEtaScheduler failed:', err.message); }
  try { stopBirthdayService(); } catch (err) { console.error('[SHUTDOWN] stopBirthdayService failed:', err.message); }
  try { stopWeeklyReporter(); } catch (err) { console.error('[SHUTDOWN] stopWeeklyReporter failed:', err.message); }
  try { stopBot(signal); } catch (err) { console.error('[SHUTDOWN] stopBot failed:', err.message); }
  try { stopServer(); } catch (err) { console.error('[SHUTDOWN] stopServer failed:', err.message); }

  leadsStopping = true;
  samsaraStopping = true;
  await Promise.allSettled([
    killWithEscalation(leadsProcess, 'LEADS-BOT'),
    killWithEscalation(samsaraProcess, 'SAMSARA-BOT'),
  ]);

  try {
    await Promise.race([
      db.pool.end(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('pool.end() timeout')), DB_DRAIN_TIMEOUT_MS)),
    ]);
    console.log('[SHUTDOWN] Database pool drained.');
  } catch (err) {
    console.error('[SHUTDOWN] Error draining pool:', err.message);
  }

  process.exit(0);
}

process.on('SIGINT', () => shutdownAll('SIGINT'));
process.on('SIGTERM', () => shutdownAll('SIGTERM'));

(async () => {
  console.log('===========================================');
  console.log('  Telegram Driver Feedback System');
  console.log('===========================================');

  try {
    await db.initializeDatabase();
  } catch (err) {
    console.error('[BOOT] Database initialization failed; aborting startup:', err.message);
    process.exit(1);
  }

  configureDispatchEtaTelegram(bot.telegram);
  startServer();
  await startBot();

  startScheduler();
  startDispatchEtaScheduler();
  startBirthdayService();
  startWeeklyReporter();
  startBackgroundAnnotator();

  startLeadsBot();
  startSamsaraBot();
})();
