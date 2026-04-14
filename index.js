/**
 * Main entry point: starts the Telegram bot, Express API server,
 * and spawns the Leads-Bot (Python/FastAPI) as a child process.
 */
const { startBot } = require('./bot/bot');
const { startServer, stopServer } = require('./server/api');
const { startScheduler, stopScheduler } = require('./services/schedulerService');
const db = require('./database/db');
const { spawn } = require('child_process');
const path = require('path');

// ─── Process-level error handlers ───
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err.message);
  console.error(err.stack);
  // Allow logs to flush, then exit — let process manager restart us
  setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason) => {
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

async function shutdownAll() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('[SHUTDOWN] Graceful shutdown initiated...');

  // 1. Stop the scheduler so no new ticks fire
  stopScheduler();

  // 2. Stop accepting new HTTP requests
  stopServer();

  // 3. Kill the Python child process
  leadsStopping = true;
  if (leadsProcess && !leadsProcess.killed) {
    console.log('[SHUTDOWN] Stopping Python process...');
    leadsProcess.kill('SIGTERM');
  }

  // 4. Kill the Samsara bot child process
  samsaraStopping = true;
  if (samsaraProcess && !samsaraProcess.killed) {
    console.log('[SHUTDOWN] Stopping Samsara bot process...');
    samsaraProcess.kill('SIGTERM');
  }

  // 5. Drain the PostgreSQL pool (waits for in-flight queries)
  try {
    await db.pool.end();
    console.log('[SHUTDOWN] Database pool drained.');
  } catch (err) {
    console.error('[SHUTDOWN] Error draining pool:', err.message);
  }

  process.exit(0);
}

process.on('SIGINT', shutdownAll);
process.on('SIGTERM', shutdownAll);

// ─── Main startup ───
(async () => {
  console.log('═══════════════════════════════════════════');
  console.log('  Telegram Driver Feedback System');
  console.log('═══════════════════════════════════════════');

  // Start the Telegram bot
  await startBot();

  // Start the Express API server
  startServer();

  // Start the scheduled message processor
  startScheduler();

  // Start the Leads-Bot (Python/FastAPI) as a child process
  startLeadsBot();

  // Start the Samsara Alert Bot as a child process
  startSamsaraBot();
})();
