/**
 * Repository hygiene sentinels — things that must never be committed.
 *
 * WHY THIS FILE EXISTS. Two entries named `node_modules` and
 * `admin/node_modules` were once committed as SYMLINKS pointing at absolute
 * paths on the machine that made them (`/home/user/...`). They slipped past
 * `.gitignore` because its patterns ended in a slash, and a trailing slash
 * matches a DIRECTORY only — a symlink wearing the same name is a different
 * kind of entry and was never ignored.
 *
 * That is not a cosmetic mistake. A fresh clone gets a dangling absolute
 * symlink where its dependency tree belongs, and `npm ci` on a deploy host
 * either fails or installs through a link into nowhere. `main` auto-deploys,
 * so the blast radius is the running application.
 *
 * These assertions read the INDEX rather than the working tree, because the
 * question is what git is carrying, not what happens to be on this disk.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

function trackedEntries() {
  // `-s` gives the mode, which is how a symlink (120000) is told from a
  // regular file (100644) — the distinction the original mistake turned on.
  const out = execFileSync('git', ['ls-files', '-s'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [meta, file] = line.split('\t');
      const [mode] = meta.split(' ');
      return { mode, file };
    });
}

let entries = null;
try {
  entries = trackedEntries();
} catch {
  // Not a git checkout (a tarball export, a vendored copy). Nothing to assert.
  entries = null;
}

test('no dependency directory is tracked in git', { skip: entries ? false : 'not a git checkout' }, () => {
  const offenders = entries
    .map((e) => e.file)
    .filter((f) => f === 'node_modules'
      || f.endsWith('/node_modules')
      || f.startsWith('node_modules/')
      || f.includes('/node_modules/'));
  assert.deepEqual(offenders, [], `node_modules must never be tracked; found: ${offenders.join(', ')}`);
});

test('no tracked entry is a symlink to an absolute path', { skip: entries ? false : 'not a git checkout' }, () => {
  const links = entries.filter((e) => e.mode === '120000');
  const absolute = [];
  for (const link of links) {
    const target = execFileSync('git', ['show', `:${link.file}`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();
    // An absolute target is meaningless anywhere but the machine that wrote
    // it. A relative one inside the repository is a legitimate thing to commit.
    if (path.posix.isAbsolute(target)) absolute.push(`${link.file} -> ${target}`);
  }
  assert.deepEqual(absolute, [], `symlinks to absolute paths cannot survive a clone; found: ${absolute.join(', ')}`);
});

test('.gitignore ignores a dependency path by NAME, not only as a directory', () => {
  const ignore = require('node:fs')
    .readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  const nodeModuleRules = ignore.filter((l) => l.replace(/\/$/, '').endsWith('node_modules'));
  assert.ok(nodeModuleRules.length > 0, '.gitignore should mention node_modules');
  const withTrailingSlash = nodeModuleRules.filter((l) => l.endsWith('/'));
  assert.deepEqual(
    withTrailingSlash,
    [],
    'a trailing slash matches directories only, which is how a symlink named node_modules got committed',
  );
});
