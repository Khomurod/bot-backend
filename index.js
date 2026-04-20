/**
 * Main entry point: starts the Telegram bot, Express API server,
 * and spawns the Leads-Bot (Python/FastAPI) as a child process.
 */
const { startBot, stopBot } = require('./bot/bot');
const { startServer, stopServer } = require('./server/api');
const { startScheduler, stopScheduler } = require('./services/schedulerService');
const { startWeeklyReporter, stopWeeklyReporter } = require('./services/weeklyReportService');
const { startBirthdayService, stopBirthdayService } = require('./services/birthdayService');
const { startBackgroundAnnotator } = require('./services/aiAnnotationService');
const db = require('./database/db');
const { spawn } = require('child_process');
const path = require('path');

function isTelegramPollingConflict(err) {
  const description = err?.response?.description || err?.message || '';
  return err?.response?.error_code === 409
    || description.includes('terminated by other getUpdates request');
}

// ─── Process-level error handlers ───
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err.message);
  console.error(err.stack);
  // Allow logs to flush, then exit — let process manager restart us
  setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason) => {
  if (isTelegramPollingConflict(reason)) {
    console.warn('[BOT] Polling conflict detected. Waiting for the retry loop to reclaim the token.');
    return;
  }

  console.error('[FATAL] Unhandled Rejection:', reason);
});

// ─── Leads-Bot (Python) child process ───
let leadsProcess = null;
let leadsStopping = false;
let restartDelay = 5000;
const MAX_RESTART_DELAY = 60000;

function startLeadsBot() {
  if (leadsStopping) return;

  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
  const scriptPath = path.join(__dirname, 'leads-bot', 'main.py');

  console.log('[LEADS-BOT] Starting Python process...');
  leadsProcess = spawn(pythonCmd, [scriptPath], {
    cwd: path.join(__dirname, 'leads-bot'),
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  leadsProcess.stdout.on('data', (data) => {
    const lines = data.toString().trim().split('\n');
    lines.forEach((line) => console.log(`[LEADS-BOT] ${line}`));
  });

  leadsProcess.stderr.on('data', (data) => {
    const lines = data.toString().trim().split('\n');
    lines.forEach((line) => console.log(`[LEADS-BOT] ${line}`));
  });

  leadsProcess.on('exit', (code) => {
    if (leadsStopping) {
      console.log('[LEADS-BOT] Process stopped.');
      return;
    }
    console.error(`[LEADS-BOT] Process exited with code ${code}. Restarting in ${restartDelay / 1000}s...`);
    setTimeout(startLeadsBot, restartDelay);
    // Exponential backoff: 5s → 10s → 20s → 40s → 60s (cap)
    restartDelay = Math.min(restartDelay * 2, MAX_RESTART_DELAY);
  });

  leadsProcess.on('error', (err) => {
    console.error(`[LEADS-BOT] Failed to start: ${err.message}`);
    if (!leadsStopping) {
      console.log(`[LEADS-BOT] Retrying in ${restartDelay / 1000}s...`);
      setTimeout(startLeadsBot, restartDelay);
      restartDelay = Math.min(restartDelay * 2, MAX_RESTART_DELAY);
    }
  });

  // Reset backoff on successful startup (stays alive > 10s)
  setTimeout(() => {
    if (leadsProcess && !leadsProcess.killed) {
      restartDelay = 5000;
    }
  }, 10000);
}

// ─── Samsara-Bot (Node.js) child process ───
let samsaraProcess = null;
let samsaraStopping = false;
let samsaraRestartDelay = 5000;

function startSamsaraBot() {
  if (samsaraStopping) return;

  console.log('[SAMSARA-BOT] Starting Node process...');
  samsaraProcess = spawn('node', ['index.js'], {
    cwd: path.join(__dirname, 'samsara-integration'),
    env: {
      ...process.env,
      // Use dedicated token so it runs as a separate bot
      TELEGRAM_BOT_TOKEN: process.env.SAMSARA_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN,
      SAMSARA_API_KEY: process.env.SAMSARA_API_KEY,
      // Separate port so it doesn't collide with the main Express server
      PORT: process.env.SAMSARA_PORT || '3002',
      WEBHOOK_PORT: process.env.SAMSARA_PORT || '3002',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  samsaraProcess.stdout.on('data', (data) => {
    const lines = data.toString().trim().split('\n');
    lines.forEach((line) => console.log(`[SAMSARA-BOT] ${line}`));
  });

  samsaraProcess.stderr.on('data', (data) => {
    const lines = data.toString().trim().split('\n');
    lines.forEach((line) => console.error(`[SAMSARA-BOT] ${line}`));
  });

  samsaraProcess.on('exit', (code) => {
    if (samsaraStopping) {
      console.log('[SAMSARA-BOT] Process stopped.');
      return;
    }
    console.error(`[SAMSARA-BOT] Process exited with code ${code}. Restarting in ${samsaraRestartDelay / 1000}s...`);
    setTimeout(startSamsaraBot, samsaraRestartDelay);
    samsaraRestartDelay = Math.min(samsaraRestartDelay * 2, MAX_RESTART_DELAY);
  });

  samsaraProcess.on('error', (err) => {
    console.error(`[SAMSARA-BOT] Failed to start: ${err.message}`);
    if (!samsaraStopping) {
      console.log(`[SAMSARA-BOT] Retrying in ${samsaraRestartDelay / 1000}s...`);
      setTimeout(startSamsaraBot, samsaraRestartDelay);
      samsaraRestartDelay = Math.min(samsaraRestartDelay * 2, MAX_RESTART_DELAY);
    }
  });

  // Reset backoff on successful startup (stays alive > 10s)
  setTimeout(() => {
    if (samsaraProcess && !samsaraProcess.killed) {
      samsaraRestartDelay = 5000;
    }
  }, 10000);
}

// ─── Graceful shutdown ───
let isShuttingDown = false;

const CHILD_SHUTDOWN_TIMEOUT_MS = 8000;
const DB_DRAIN_TIMEOUT_MS = 5000;

// Send SIGTERM; escalate to SIGKILL after timeout so a hung child doesn't
// block the entire shutdown and trigger Render to SIGKILL the whole dyno.
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
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      }
      done();
    }, CHILD_SHUTDOWN_TIMEOUT_MS);
    proc.once('exit', () => {
      clearTimeout(timer);
      done();
    });
    try { proc.kill('SIGTERM'); } catch { /* ignore */ }
  });
}

async function shutdownAll(signal = 'SIGTERM') {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[SHUTDOWN] Graceful shutdown initiated (${signal})...`);

  // 1. Stop scheduled background services so no new ticks fire.
  try { stopScheduler(); } catch (err) { console.error('[SHUTDOWN] stopScheduler failed:', err.message); }
  try { stopBirthdayService(); } catch (err) { console.error('[SHUTDOWN] stopBirthdayService failed:', err.message); }
  try { stopWeeklyReporter(); } catch (err) { console.error('[SHUTDOWN] stopWeeklyReporter failed:', err.message); }

  // 2. Stop the Telegram bot polling loop so in-flight updates drain.
  try { stopBot(signal); } catch (err) { console.error('[SHUTDOWN] stopBot failed:', err.message); }

  // 3. Stop accepting new HTTP requests.
  try { stopServer(); } catch (err) { console.error('[SHUTDOWN] stopServer failed:', err.message); }

  // 4. Kill the Python and Samsara child processes with SIGKILL fallback.
  leadsStopping = true;
  samsaraStopping = true;
  await Promise.allSettled([
    killWithEscalation(leadsProcess, 'LEADS-BOT'),
    killWithEscalation(samsaraProcess, 'SAMSARA-BOT'),
  ]);

  // 5. Drain the PostgreSQL pool with a timeout so a stuck client can't
  //    wedge shutdown indefinitely.
  try {
    await Promise.race([
      db.pool.end(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('pool.end() timeout')), DB_DRAIN_TIMEOUT_MS)),
    ]);
    console.log('[SHUTDOWN] Database pool drained.');
  } catch (err) {
    console.error('[SHUTDOWN] Error draining pool:', err.message);
  }

  process.exit(0);
}

process.on('SIGINT', () => shutdownAll('SIGINT'));
process.on('SIGTERM', () => shutdownAll('SIGTERM'));

// ─── Main startup ───
(async () => {
  console.log('═══════════════════════════════════════════');
  console.log('  Telegram Driver Feedback System');
  console.log('═══════════════════════════════════════════');

  // 1. Migrate the DB schema BEFORE anything starts serving traffic.
  //    If this fails, there is no point in booting the API or bot because
  //    every request would hit an unmigrated schema.
  try {
    await db.initializeDatabase();
  } catch (err) {
    console.error('[BOOT] Database initialization failed — aborting startup:', err.message);
    process.exit(1);
  }

  // 2. Start the Express API server (health check comes up ASAP for Render).
  startServer();

  // 3. Launch the Telegram bot.
  await startBot();

  // 4. Start background services that depend on bot + DB.
  startScheduler();
  startBirthdayService();
  startWeeklyReporter();
  startBackgroundAnnotator();

  // 5. Spawn independent child processes.
  startLeadsBot();
  startSamsaraBot();
})();
