/**
 * Main entry point: starts the Telegram bot, Express API server,
 * and spawns the Leads-Bot (Python/FastAPI) as a child process.
 */
const { startBot } = require('./bot/bot');
const { startServer } = require('./server/api');
const { spawn } = require('child_process');
const path = require('path');

// ─── Process-level error handlers ───
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err.message);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled Rejection:', reason);
});

// ─── Leads-Bot (Python) child process ───
let leadsProcess = null;
let leadsStopping = false;

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
    console.error(`[LEADS-BOT] Process exited with code ${code}. Restarting in 5s...`);
    setTimeout(startLeadsBot, 5000);
  });

  leadsProcess.on('error', (err) => {
    console.error(`[LEADS-BOT] Failed to start: ${err.message}`);
    if (!leadsStopping) {
      console.log('[LEADS-BOT] Retrying in 5s...');
      setTimeout(startLeadsBot, 5000);
    }
  });
}

// ─── Graceful shutdown ───
function shutdownAll() {
  leadsStopping = true;
  if (leadsProcess && !leadsProcess.killed) {
    console.log('[LEADS-BOT] Stopping Python process...');
    leadsProcess.kill('SIGTERM');
  }
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

  // Start the Leads-Bot (Python/FastAPI) as a child process
  startLeadsBot();
})();
