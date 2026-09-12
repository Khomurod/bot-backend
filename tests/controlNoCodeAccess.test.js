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
  'lib/control/fingerprint.js',
  'services/control/actions.js',
  'services/control/replyHandler.js',
  'services/control/askPass.js',
  'services/control/aiIntent.js',
  'services/control/memory.js',
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

test('THE DECIDER AND THE WRITER STAY MODEL-FREE', () => {
  // B2 added an AI reading, and it lives in exactly one file. These three are
  // the ones it may never enter: the deterministic parser (whose whole value is
  // that no model can reach its decision), the writer (the only thing that
  // changes the fleet), and the memory (what gets remembered must be what a
  // person said).
  for (const rel of [
    'lib/control/intent.js',
    'lib/control/fingerprint.js',
    'services/control/actions.js',
    'services/control/memory.js',
  ]) {
    const source = codeOnly(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    assert.ok(!/runCapability|groqClient|geminiClient|services\/ai\//.test(source), rel);
  }
});

test('the reply handler reaches a model ONLY through the one governed module', () => {
  // It may call `./aiIntent`, which goes through the router — where the
  // capability switch, the cooldowns and the call log live. It may not reach a
  // provider client directly, which would route around all three.
  const source = codeOnly(
    fs.readFileSync(path.join(ROOT, 'services/control/replyHandler.js'), 'utf8')
  );
  assert.ok(!/groqClient|geminiClient|services\/ai\/|runCapability/.test(source),
    'replyHandler.js must reach AI only via ./aiIntent');
  assert.ok(/require\('\.\/aiIntent'\)/.test(source), 'and it does use that one');
});

test('the AI reading may only CHOOSE — it never names a value that lands in a record', () => {
  const source = codeOnly(
    fs.readFileSync(path.join(ROOT, 'services/control/aiIntent.js'), 'utf8')
  );
  // It must not import the writer, the correction registry, or the findings
  // store. Its whole output is one key from a list somebody else wrote.
  for (const mod of requiresIn(source)) {
    assert.ok(
      !/corrections|operationalFindings|\.\/actions/.test(mod),
      `services/control/aiIntent.js imports "${mod}" — the model may choose, never write`
    );
  }
});

/**
 * THE ENGINEERING-REQUEST TABLE IS THE END OF THE ROAD, not a staging area.
 *
 * An owner typing "just fix the code" produces a row and nothing else. The
 * guarantee is kept by the schema having nowhere to put a patch, so this reads
 * the migration itself: a column named for a diff, a file, a branch or a
 * command is the shape somebody would add on the way to executing one, and it
 * should fail a test the day it appears rather than be noticed later.
 */
test('NO COLUMN IN engineering_requests COULD HOLD CODE OR A PATH', () => {
  const sql = fs.readFileSync(
    path.join(ROOT, 'database', 'migrations', '0051_engineering_requests.sql'), 'utf8'
  );
  const body = sql.slice(sql.indexOf('CREATE TABLE'), sql.indexOf('CREATE UNIQUE INDEX'));
  for (const banned of [
    /\bpatch\b/i, /\bdiff\b/i, /\bfile_path\b/i, /\bfilename\b/i,
    /\bbranch\b/i, /\bcommand\b/i, /\bscript\b/i, /\bsource_code\b/i,
  ]) {
    assert.ok(!banned.test(body),
      `0051 defines something matching ${banned} — the bot does not edit source, and a `
      + 'column that could hold one is how that stops being true');
  }
});

test('the engineering path reaches no filesystem, process or network either', () => {
  for (const rel of [
    'database/engineeringRequests.js',
    'services/operations/checks/engineering.js',
    'server/routes/operations/engineeringRoutes.js',
  ]) {
    const source = codeOnly(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    for (const mod of requiresIn(source)) {
      assert.ok(!BANNED_MODULES.includes(mod), `${rel} imports "${mod}"`);
    }
    for (const pattern of [/\bexecSync?\b/, /\bspawnSync?\b/, /\beval\b/, /new\s+Function\b/]) {
      assert.ok(!pattern.test(source), `${rel} matches ${pattern}`);
    }
  }
});

test('the check for an open request proposes nothing — there is no automatic answer', () => {
  // The resolution is a person writing code. An action here would mean
  // inventing one, and an invented action would be the bot acting on a request
  // to change itself.
  const { runEngineeringChecks } = require('../services/operations/checks/engineering');
  const findings = runEngineeringChecks({
    now: new Date(),
    engineeringRequests: [{ id: 1, requestText: 'this is wrong', createdAt: new Date().toISOString(), source: 'control_reply' }],
  });
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].proposedChange, null);
  assert.strictEqual(findings[0].tier, 'warning');

  const { CHECK_TO_ACTION } = require('../services/operations/corrections/actions');
  assert.strictEqual(CHECK_TO_ACTION['engineering.request_open'], undefined,
    'no correction may be registered for it');
});

test('A FAILED READ IS NOT AN EMPTY LIST — the sweep must not clear the board', () => {
  // The consistency sweep resolves the findings of every check that RAN. A read
  // that failed, or one truncated by a cap, reported as [] would say every
  // request had been dealt with and would clear them off Needs Attention — an
  // unavailable table mistaken for proof somebody did the work.
  const { runEngineeringChecks, MAX_REQUESTS } = require('../services/operations/checks/engineering');

  assert.throws(
    () => runEngineeringChecks({ now: new Date(), engineeringRequests: null }),
    /could not be read/,
  );
  assert.throws(
    () => runEngineeringChecks({ now: new Date() }),
    /could not be read/, 'a snapshot with no field at all is also not an empty list'
  );

  const atCeiling = Array.from({ length: MAX_REQUESTS }, (_, i) => ({
    id: i + 1, requestText: 'x', createdAt: new Date().toISOString(), source: 'admin',
  }));
  assert.throws(() => runEngineeringChecks({ now: new Date(), engineeringRequests: atCeiling }),
    /partial/);

  // And a genuinely empty list still runs, so the keys resolve when the last
  // request is decided.
  assert.deepStrictEqual(runEngineeringChecks({ now: new Date(), engineeringRequests: [] }), []);
});
