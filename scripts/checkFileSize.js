#!/usr/bin/env node
/**
 * Enforces the 500-physical-line limit from CLAUDE.md ("Maximum source-file
 * size") across the WHOLE repository.
 *
 * There is no baseline and no exemption list any more. Every hand-written
 * source, test and config file must be at or under the limit, so the rule
 * "no hand-written source/test file may exceed 500 lines" is literally true and
 * a new violation cannot be waved through by editing a JSON file.
 *
 * SCANNING STRATEGY — deny-list, not allow-list. The scanner walks from the
 * repository root and skips only what is provably not hand-written (installed
 * dependencies, build output, caches, minified bundles). An earlier version
 * walked a hard-coded list of INCLUDED directories, which silently missed
 * whole areas as the tree grew: first `leads-bot/` and its Python, then
 * `admin/vite.config.js` and friends sitting one level above `admin/src`.
 * Inverting the default means a new directory of hand-written code is covered
 * the moment it is created, with no list to remember to update.
 *
 * Usage:
 *   node scripts/checkFileSize.js         # enforce (CI)
 *   node scripts/checkFileSize.js --list  # report every file over the limit
 *
 * Dependency-free, and identical on Windows and Linux (paths are normalized to
 * forward slashes). Exported for tests/checkFileSize.test.js, which drives it
 * against fixture trees so the exclusion rules stay honest.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LIMIT = 500;
const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Extensions treated as hand-written code. Stylesheets, Markdown and data files
 * are deliberately absent: the rule is about code modularity, and a long
 * stylesheet or brief is not a module-boundary problem.
 */
const SOURCE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py',
]);

/**
 * Directory names skipped ANYWHERE in the tree. Each is machine-produced:
 * installed packages, build/test output, or interpreter caches.
 */
const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg',
  'build', 'dist', 'out', 'coverage', '.next', '.nuxt', '.turbo', '.cache',
  'vendor', '__generated__', '__pycache__',
  '.venv', 'venv', 'env-venv', 'site-packages',
  '.pytest_cache', '.mypy_cache', '.ruff_cache',
]);

/**
 * Files that carry a source extension but are generated, vendored or minified.
 * Keep this list tiny and specific — it is the only remaining way for a file to
 * escape the limit, so a wildcard here would reopen the hole this design closes.
 */
const EXCLUDED_FILE_PATTERNS = [
  /\.min\.(js|mjs|cjs)$/,
  /\.bundle\.(js|mjs|cjs)$/,
  /\.generated\.(js|mjs|cjs|jsx|ts|tsx|py)$/,
  /(^|\/)eng\.traineddata$/,
];

/** Physical line count, matching `wc -l` intent (a trailing newline is not a line). */
function countLines(absPath) {
  const text = fs.readFileSync(absPath, 'utf8');
  if (text === '') return 0;
  const lines = text.split(/\r\n|\r|\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

function toPosix(relPath) {
  return relPath.split(path.sep).join('/');
}

/** True when a repo-relative path is hand-written code subject to the limit. */
function isSourceFile(repoPath) {
  if (!SOURCE_EXTENSIONS.has(path.extname(repoPath))) return false;
  return !EXCLUDED_FILE_PATTERNS.some((re) => re.test(repoPath));
}

/** Every hand-written source/test/config file under `root`, repo-relative and sorted. */
function collectSourceFiles(root = REPO_ROOT) {
  const found = [];

  function walk(absDir) {
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (_) {
      return; // unreadable or vanished mid-walk; nothing to enforce
    }
    for (const entry of entries) {
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        walk(abs);
      } else if (entry.isFile()) {
        const repoPath = toPosix(path.relative(root, abs));
        if (isSourceFile(repoPath)) found.push(repoPath);
      }
    }
  }

  walk(root);
  return found.sort();
}

/** `[[repoPath, lines], …]` for files over the limit, largest first. */
function findOversized(root = REPO_ROOT) {
  const rows = [];
  for (const repoPath of collectSourceFiles(root)) {
    const lines = countLines(path.join(root, repoPath));
    if (lines > LIMIT) rows.push([repoPath, lines]);
  }
  return rows.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function listAll(root = REPO_ROOT) {
  const rows = findOversized(root);
  const scanned = collectSourceFiles(root).length;
  if (!rows.length) {
    console.log(`No file exceeds ${LIMIT} lines (${scanned} source files scanned).`);
    return 0;
  }
  console.log(`Files over ${LIMIT} physical lines (${rows.length} of ${scanned} scanned):\n`);
  for (const [file, lines] of rows) {
    console.log(`  ${String(lines).padStart(5)}  ${file}  (+${lines - LIMIT})`);
  }
  return 0;
}

function enforce(root = REPO_ROOT) {
  const rows = findOversized(root);
  const scanned = collectSourceFiles(root).length;

  if (!rows.length) {
    console.log(`OK — no file over ${LIMIT} lines (${scanned} source files scanned).`);
    return 0;
  }

  console.error(`\nFAIL — ${rows.length} file${rows.length === 1 ? '' : 's'} over the ${LIMIT}-line limit:\n`);
  for (const [file, lines] of rows) {
    console.error(`  ${String(lines).padStart(5)}  ${file}  (+${lines - LIMIT})`);
  }
  console.error(
    '\nSplit by cohesive responsibility, not arbitrary line ranges — see\n'
    + 'CLAUDE.md → Maximum source-file size. Reformatting to pack more code onto\n'
    + 'fewer lines does not count as a fix.\n',
  );
  return 1;
}

function main() {
  return process.argv[2] === '--list' ? listAll() : enforce();
}

module.exports = {
  LIMIT,
  REPO_ROOT,
  SOURCE_EXTENSIONS,
  EXCLUDED_DIRS,
  EXCLUDED_FILE_PATTERNS,
  countLines,
  isSourceFile,
  collectSourceFiles,
  findOversized,
  enforce,
  listAll,
};

if (require.main === module) process.exit(main());
