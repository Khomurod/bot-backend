/**
 * Installs leads-bot Python dependencies during npm postinstall (e.g. Render default `npm install`).
 * Tries common Python invocations for Linux/macOS/Windows.
 */
const { execFileSync } = require('child_process');
const path = require('path');

const requirementsPath = path.join(__dirname, '..', 'leads-bot', 'requirements.txt');
const attempts = [
  ['python3', ['-m', 'pip', 'install', '-r', requirementsPath]],
  ['python', ['-m', 'pip', 'install', '-r', requirementsPath]],
  ['py', ['-3', '-m', 'pip', 'install', '-r', requirementsPath]],
];

for (const [cmd, args] of attempts) {
  try {
    execFileSync(cmd, args, { stdio: 'inherit' });
    process.exit(0);
  } catch {
    // try next candidate
  }
}

console.error(
  '[postinstall] Could not install leads-bot Python deps (uvicorn, etc.). '
  + 'Install Python 3 with pip, or run: pip install -r leads-bot/requirements.txt',
);
process.exit(1);
