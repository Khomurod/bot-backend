/**
 * The undefined-identifier gate is the thing that would have caught the
 * production incident, so the GATE ITSELF is under test here.
 *
 * What shipped: a module-splitting refactor left 26 identifiers behind in the
 * files that no longer imported them — `getDaysUntilBirthday` in the Driver
 * Groups shaping module, `activeRun` in the mileage-bonus scheduler, 24 more —
 * and `vite build` passed every single time. A bundler treats an unresolved
 * module-scope name as a global and defers the failure to runtime, so the
 * admin panel threw ReferenceError the moment each page opened and the
 * mileage-bonus tick threw on every scheduled pass. A build is not a scope
 * check.
 *
 * These tests assert three separate things, because a gate can fail in three
 * separate ways:
 *
 *   1. it FIRES on the two bug shapes that actually shipped;
 *   2. it does not fire on legitimate code (a gate with false positives gets
 *      switched off);
 *   3. it COVERS every hand-written file — the first version of the config
 *      listed directories to lint and ten real files sat outside that list,
 *      four of them named in `ignores` under a block that claimed to lint
 *      them. The coverage test below has no list to update: it walks the
 *      repository and asserts `no-undef` is in force for whatever it finds.
 *
 * Everything here runs against in-memory sources or the config alone, so there
 * is no database, no secrets and no network.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ESLint } = require('eslint');

const { collectSourceFiles } = require('../scripts/checkFileSize');

const REPO_ROOT = path.join(__dirname, '..');

/** One ESLint instance for the whole file: loading the config is the slow part. */
const eslint = new ESLint({ cwd: REPO_ROOT });

/**
 * Lint `code` as if it were the file at `relPath`, without writing anything.
 *
 * The path is what selects the config block (Node vs browser, script vs
 * module), so each case below names a path inside the tree it is testing.
 */
async function lintAs(relPath, code) {
  const [result] = await eslint.lintText(code, { filePath: path.join(REPO_ROOT, relPath) });
  return result.messages;
}

/** Just the undefined-identifier names, in source order. */
async function undefinedNames(relPath, code) {
  const messages = await lintAs(relPath, code);
  const fatal = messages.filter((m) => m.fatal);
  assert.deepEqual(fatal, [], `parse error in fixture ${relPath}: ${fatal.map((m) => m.message).join('; ')}`);
  return messages
    .filter((m) => m.ruleId === 'no-undef')
    .map((m) => /'(.+?)' is not defined/.exec(m.message)?.[1]);
}

// ── 1. it fires on the shapes that shipped ──

test('an admin module that uses a name it never imported is reported', async () => {
  // The literal bug the user saw in the browser console: the Driver Groups
  // shaping module sorted by a helper its import statement had dropped.
  const names = await undefinedNames('admin/src/pages/groups/driverProfileShaping.js', `
    import { sortBySoonestBirthday } from "../../components/Shared";

    export function prepareDisplayProfiles(profiles) {
      return [...profiles].sort((a, b) =>
        sortBySoonestBirthday(a, b) || getDaysUntilBirthday(a.birthday) - getDaysUntilBirthday(b.birthday));
    }
  `);
  assert.deepEqual([...new Set(names)], ['getDaysUntilBirthday']);
});

test('the same module with the import present is clean', async () => {
  const names = await undefinedNames('admin/src/pages/groups/driverProfileShaping.js', `
    import { getDaysUntilBirthday, sortBySoonestBirthday } from "../../components/Shared";

    export function prepareDisplayProfiles(profiles) {
      return [...profiles].sort((a, b) =>
        sortBySoonestBirthday(a, b) || getDaysUntilBirthday(a.birthday) - getDaysUntilBirthday(b.birthday));
    }
  `);
  assert.deepEqual(names, []);
});

test('a backend module reading another module\'s private state is reported', async () => {
  // The literal bug in the Render logs: `activeRun` is module-private inside
  // services/mileageBonus/runState.js, and the scheduler referenced it by name
  // instead of through the exported isRunning() accessor.
  const names = await undefinedNames('services/mileageBonusService.js', `
    const { isRunning } = require('./mileageBonus/runState');

    async function tick() {
      if (activeRun) return { retry: false };
      return { retry: isRunning() };
    }

    module.exports = { tick };
  `);
  assert.deepEqual(names, ['activeRun']);
});

test('a JSX component using a prop it never destructured is reported', async () => {
  // The third shape from the same refactor: a card was sliced into its own
  // component and kept reading a value the new props no longer carried.
  const names = await undefinedNames('admin/src/pages/homeTime/DriverListCard.jsx', `
    import React from "react";

    export function DriverListCard({ filteredStatuses }) {
      return (
        <table>
          <tbody>
            {filteredStatuses.map((driver) => (
              <tr key={driver.group_id} className={driver.group_id === selectedGroupId ? "sel" : ""}>
                <td>{driver.unit_number}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
  `);
  assert.deepEqual(names, ['selectedGroupId']);
});

// ── 2. it stays quiet on legitimate code ──

test('Node globals are known in backend files', async () => {
  const names = await undefinedNames('services/probe.js', `
    const path = require('path');

    module.exports = function probe() {
      const timer = setTimeout(() => {}, 10);
      clearTimeout(timer);
      return { dir: __dirname, file: __filename, env: process.env.NODE_ENV, buf: Buffer.from(path.sep) };
    };
  `);
  assert.deepEqual(names, [], 'require/module/process/__dirname/Buffer/timers must not be flagged');
});

test('browser globals are known in admin files', async () => {
  const names = await undefinedNames('admin/src/api/probe.js', `
    export async function load() {
      const token = localStorage.getItem('token');
      const res = await fetch('/api/x', { headers: { Authorization: 'Bearer ' + token } });
      if (!res.ok) console.warn(window.location.pathname, document.title, navigator.onLine);
      return new URLSearchParams({ a: '1' }).toString();
    }
  `);
  assert.deepEqual(names, [], 'fetch/localStorage/window/document/navigator must not be flagged');
});

test('the browser scripts served by the QBQ pages are linted, not ignored', async () => {
  // These four files were named in `ignores` while a block below claimed to
  // lint them. Ignore wins, so they were unchecked for their whole life.
  const names = await undefinedNames('server/qbq/public/probe.js', `
    document.addEventListener('click', function () {
      var el = document.querySelector('#x');
      el.textContent = String(neverDeclared);
    });
  `);
  assert.deepEqual(names, ['neverDeclared']);
});

// ── 3. it covers every hand-written file ──

test('every hand-written JS file in the repository has no-undef in force', async () => {
  // No allow-list: this walks the tree (via the file-size scanner's collector,
  // which skips only provably machine-produced paths) and asserts the config
  // reaches each file. A new directory of hand-written code is covered the
  // moment it is created, and a new extension fails here instead of silently
  // escaping.
  const files = collectSourceFiles(REPO_ROOT).filter((rel) => /\.(js|jsx|mjs|cjs)$/.test(rel));
  assert.ok(files.length > 500, `expected the whole tree, collected only ${files.length} files`);

  const uncovered = [];
  for (const rel of files) {
    // eslint-disable-next-line no-await-in-loop -- config resolution is cached; concurrency buys nothing here
    const config = await eslint.calculateConfigForFile(path.join(REPO_ROOT, rel));
    const severity = config?.rules?.['no-undef']?.[0];
    if (severity !== 'error' && severity !== 2) uncovered.push(rel);
  }

  assert.deepEqual(uncovered, [], `no-undef is not in force for:\n${uncovered.map((f) => `  ${f}`).join('\n')}`);
});

// ── the gate is actually wired in ──

test('npm test runs the gate', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.scripts['lint:undef'] || '', /eslint/, 'the lint:undef script must invoke eslint');
  assert.match(
    pkg.scripts.test || '',
    /lint:undef/,
    'npm test must run lint:undef — a gate nobody runs is not a gate',
  );
});

test('CI runs the gate', () => {
  const ci = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(ci, /npm run lint:undef/, 'the CI workflow must run lint:undef');
});
