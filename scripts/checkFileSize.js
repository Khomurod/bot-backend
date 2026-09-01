#!/usr/bin/env node
/**
 * Enforces the 500-physical-line limit from CLAUDE.md ("Maximum source-file
 * size") for hand-written source and test files.
 *
 * The repository has pre-existing violations that predate the rule, so a plain
 * repo-wide check would fail CI on day one. Instead this uses a BASELINE
 * (scripts/fileSizeBaseline.json) of known offenders:
 *
 *   • a file NOT in the baseline that exceeds the limit  → failure (new debt)
 *   • a baselined file that GREW since the baseline      → failure (worse debt)
 *   • a baselined file at or under its recorded size     → allowed, reported
 *   • a baselined file that drops to/below the limit     → failure, telling you
 *     to remove it from the baseline (so wins are locked in)
 *
 * The baseline can therefore only ever shrink — that is the staged path to full
 * enforcement.
 *
 * Usage:
 *   node scripts/checkFileSize.js            # enforce (CI)
 *   node scripts/checkFileSize.js --list     # list every file over the limit
 *   node scripts/checkFileSize.js --update-baseline
 *
 * Dependency-free and identical on Windows and Linux (paths are normalized to
 * forward slashes).
 */
const fs = require('node:fs');
const path = require('node:path');

const LIMIT = 500;
const ROOT = path.resolve(__dirname, '..');
const BASELINE_PATH = path.join(__dirname, 'fileSizeBaseline.json');

// Explicit included roots — anything outside these is not hand-written app code.
const INCLUDE_DIRS = [
  'bot', 'database', 'scripts', 'server', 'services', 'tests',
  'admin/src', 'fleet/src', 'leads-bot', 'config', 'utils',
];
// CLAUDE.md states the 500-line rule for every hand-written source or test
// file, not just JavaScript — the Python leads worker is hand-written code too.
const INCLUDE_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py']);

// Generated / vendored / build output — never hand-written.
const EXCLUDE_DIR_NAMES = new Set([
  'node_modules', 'build', 'dist', 'coverage', '.git', 'vendor', '__generated__',
  '__pycache__',
]);
// Generated or machine-maintained files, and documented schema exceptions.
const EXCLUDE_FILE_PATTERNS = [
  /(^|\/)package-lock\.json$/,
  /\.min\.js$/,
  /\.bundle\.js$/,
  /(^|\/)fileSizeBaseline\.json$/,
];

/** Physical line count: every newline-separated line, matching `wc -l` intent. */
function countLines(absPath) {
  const text = fs.readFileSync(absPath, 'utf8');
  if (text === '') return 0;
  const lines = text.split(/\r\n|\r|\n/);
  // A trailing newline produces a final empty element that is not a line.
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

function toRepoPath(absPath) {
  return path.relative(ROOT, absPath).split(path.sep).join('/');
}

function isExcluded(repoPath) {
  return EXCLUDE_FILE_PATTERNS.some((re) => re.test(repoPath));
}

function walk(absDir, out) {
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch (_) {
    return out; // an optional directory (e.g. fleet/src) may not exist
  }
  for (const entry of entries) {
    const abs = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDE_DIR_NAMES.has(entry.name)) continue;
      walk(abs, out);
    } else if (entry.isFile() && INCLUDE_EXT.has(path.extname(entry.name))) {
      const repoPath = toRepoPath(abs);
      if (!isExcluded(repoPath)) out.push(repoPath);
    }
  }
  return out;
}

/** Every included hand-written source/test file, as sorted repo-relative paths. */
function collectFiles() {
  const out = [];
  for (const dir of INCLUDE_DIRS) walk(path.join(ROOT, dir), out);
  return out.sort();
}

/** { repoPath: lines } for every file currently over the limit. */
function findOversized() {
  const oversized = {};
  for (const repoPath of collectFiles()) {
    const lines = countLines(path.join(ROOT, repoPath));
    if (lines > LIMIT) oversized[repoPath] = lines;
  }
  return oversized;
}

function readBaseline() {
  try {
    return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')).files || {};
  } catch (_) {
    return {};
  }
}

function writeBaseline(oversized) {
  const body = {
    comment: 'Pre-existing files over the 500-line limit (see CLAUDE.md → Maximum source-file size). '
      + 'This list may only shrink: new violations fail the check, and a file listed here may never grow. '
      + 'Regenerate with: node scripts/checkFileSize.js --update-baseline',
    limit: LIMIT,
    files: Object.fromEntries(Object.entries(oversized).sort(([a], [b]) => a.localeCompare(b))),
  };
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(body, null, 2)}\n`);
}

function listAll() {
  const oversized = findOversized();
  const rows = Object.entries(oversized).sort((a, b) => b[1] - a[1]);
  if (!rows.length) {
    console.log(`No file exceeds ${LIMIT} lines.`);
    return 0;
  }
  console.log(`Files over ${LIMIT} physical lines (${rows.length}):\n`);
  for (const [file, lines] of rows) console.log(`  ${String(lines).padStart(5)}  ${file}`);
  return 0;
}

function enforce() {
  const baseline = readBaseline();
  const oversized = findOversized();

  const added = [];
  const grew = [];
  for (const [file, lines] of Object.entries(oversized)) {
    if (!(file in baseline)) added.push([file, lines]);
    else if (lines > baseline[file]) grew.push([file, lines, baseline[file]]);
  }
  // A baselined file that is now compliant must be removed from the baseline so
  // the improvement can never silently regress.
  const fixed = Object.keys(baseline).filter((file) => !(file in oversized));

  if (!added.length && !grew.length && !fixed.length) {
    const n = Object.keys(baseline).length;
    console.log(`OK — no new files over ${LIMIT} lines.`
      + `${n ? ` ${n} pre-existing violation${n === 1 ? '' : 's'} tracked in the baseline.` : ''}`);
    return 0;
  }

  if (added.length) {
    console.error(`\nFAIL — ${added.length} file${added.length === 1 ? '' : 's'} over the ${LIMIT}-line limit:\n`);
    for (const [file, lines] of added.sort((a, b) => b[1] - a[1])) {
      console.error(`  ${String(lines).padStart(5)}  ${file}  (+${lines - LIMIT})`);
    }
    console.error('\nSplit by cohesive responsibility — see CLAUDE.md → Maximum source-file size.');
  }
  if (grew.length) {
    console.error(`\nFAIL — ${grew.length} already-oversized file${grew.length === 1 ? '' : 's'} grew:\n`);
    for (const [file, lines, was] of grew) {
      console.error(`  ${file}: ${was} → ${lines} (+${lines - was})`);
    }
    console.error('\nFiles in the baseline may only shrink. Reduce this file as part of your change.');
  }
  if (fixed.length) {
    console.error(`\nFAIL — ${fixed.length} baselined file${fixed.length === 1 ? '' : 's'} now comply. `
      + 'Remove them from the baseline to lock the win in:\n');
    for (const file of fixed) console.error(`  ${file}`);
    console.error('\nRun: node scripts/checkFileSize.js --update-baseline');
  }
  return 1;
}

function main() {
  const arg = process.argv[2];
  if (arg === '--list') return listAll();
  if (arg === '--update-baseline') {
    const oversized = findOversized();
    writeBaseline(oversized);
    console.log(`Baseline updated: ${Object.keys(oversized).length} file(s) over ${LIMIT} lines.`);
    return 0;
  }
  return enforce();
}

process.exit(main());
