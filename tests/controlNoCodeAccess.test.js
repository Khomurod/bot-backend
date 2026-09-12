'use strict';

/**
 * THE RULE THIS FILE GUARDS: the runtime bot never touches source code.
 *
 * The control channel is the one place where words typed into a Telegram group
 * reach code that changes things. The owner's instruction was explicit — Wenze
 * may be steered from Telegram, and it may NOT be given the ability to rewrite
 * its own source. A prose promise is not enforcement, so this is structural:
 * the control modules are read and asserted to contain no filesystem, no
 * process spawn, no network and no git.
 *
 * It is deliberately blunt. A false positive costs a rename; a false negative
 * is an operator's sentence reaching `child_process`.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const CONTROL_FILES = [
  'lib/control/intent.js',
  'lib/control/askable.js',
  'services/control/actions.js',
  'services/control/replyHandler.js',
  'services/control/askPass.js',
  'bot/controlReplyHandlers.js',
];

/** Every import these files make, as written. */
function requiresIn(source) {
  return [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
}

/** Comments say the words on purpose; only code may not. */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const BANNED_MODULES = [
  'fs', 'node:fs', 'fs/promises', 'node:fs/promises',
  'child_process', 'node:child_process',
  'http', 'https', 'node:http', 'node:https', 'net', 'node:net',
  'vm', 'node:vm', 'module', 'node:module',
];

test('every control file exists — a renamed file must not silently leave this guard', () => {
  for (const rel of CONTROL_FILES) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} is missing from the repository`);
  }
});

test('NO CONTROL MODULE IMPORTS THE FILESYSTEM, A PROCESS, OR THE NETWORK', () => {
  for (const rel of CONTROL_FILES) {
    const source = codeOnly(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    for (const mod of requiresIn(source)) {
      assert.ok(
        !BANNED_MODULES.includes(mod),
        `${rel} imports "${mod}" — the control channel may not reach outside the database`
      );
    }
  }
});

test('no control module writes a file, spawns anything, or runs git', () => {
  const BANNED_CALLS = [
    /\bwriteFileSync?\b/, /\breadFileSync?\b/, /\bunlinkSync?\b/, /\bmkdirSync?\b/,
    /\bexecSync?\b/, /\bspawnSync?\b/, /\bexecFile\b/, /\bfork\(/,
    /\bprocess\.exit\b/, /\beval\b/, /new\s+Function\b/,
    /['"`]git\s/, /['"`]npm\s/,
  ];
  for (const rel of CONTROL_FILES) {
    const source = codeOnly(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    for (const pattern of BANNED_CALLS) {
      assert.ok(!pattern.test(source), `${rel} matches ${pattern} — the control channel may not do that`);
    }
  }
});

test('the executor reaches only a closed set of dependencies', () => {
  // The one module that changes anything. Every import it makes is listed
  // here on purpose: adding one means deciding, deliberately, that the control
  // channel may reach it.
  const source = fs.readFileSync(path.join(ROOT, 'services/control/actions.js'), 'utf8');
  const allowed = new Set([
    '../operations/corrections/apply',
    '../../database/operationalFindings',
    '../operations/corrections/autoApply',
    '../operations/corrections/actions',
    '../operations/corrections/decisionSeam',
    '../decisions/journal',
  ]);
  for (const mod of requiresIn(source)) {
    assert.ok(allowed.has(mod), `services/control/actions.js now imports "${mod}" — was that deliberate?`);
  }
});

test('the reply path contains no AI seam', () => {
  // B2 adds an AI reading, and only as a fallback for a reply the
  // deterministic parser could not read. Until then there is none, and a model
  // appearing anywhere in this path would be one nobody decided to add.
  for (const rel of ['lib/control/intent.js', 'services/control/replyHandler.js', 'services/control/actions.js']) {
    const source = codeOnly(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    assert.ok(!/runCapability|groqClient|geminiClient|services\/ai\//.test(source), rel);
  }
});
