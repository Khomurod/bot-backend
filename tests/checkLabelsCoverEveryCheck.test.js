'use strict';

/**
 * Every check the backend files has a plain name on Needs Attention.
 *
 * `checkLabel()` (admin/src/pages/operations/labels.js) falls back to the raw
 * key, so a check added without a name still renders — as
 * `home_time.board_disagrees_with_state` in the group title, the finding modal
 * and Automation. The November 2026 audit found six such keys. This test
 * reads every key the backend can file and holds the label table to it.
 *
 * It reads source text on purpose: the label table is an ES module the Node
 * suite cannot import, and the keys are scattered across services that would
 * need a database to run.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
// Code only: a comment may show an example key that nothing files.
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function sources(dir, out = []) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') sources(rel, out);
    } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) out.push(rel);
  }
  return out;
}

const QUOTED_KEY = /'([a-z_]+\.[a-z_]+)'/g;
const quotedKeys = (fragment) => [...fragment.matchAll(QUOTED_KEY)].map((m) => m[1]);

/**
 * The places a check key is DECLARED, and only those, so an unrelated dotted
 * string elsewhere is never taken for one:
 *   - `checkKey: 'a.b'`, or a ternary on that line
 *     (`checkKey: botObserved ? 'identity.status_disagreement' : '…'`);
 *   - `const CHECK_X = 'a.b'`;
 *   - a check module's `CHECK_KEYS = [ … ]` list (RETIRED_CHECK_KEYS is not
 *     matched: those no longer file anything);
 *   - a `CHECKS = { NAME: 'a.b', … }` table, the form lib/identity's
 *     resolvers use (`CHECKS.UNNAMED` in a CHECK_KEYS list is its key);
 *   - the contradiction pass's keys, which it derives as `context.<kind>`
 *     from its SEVERITY table (contradictionPass.js, checkKeyFor) — read from
 *     that table, so a kind added there needs a name here.
 */
function filedCheckKeys() {
  const keys = new Set();
  for (const rel of ['services', 'lib', 'database', 'bot', 'server'].flatMap((d) => sources(d))) {
    const text = code(read(rel));
    for (const m of text.matchAll(/checkKey:([^\n]*)/g)) quotedKeys(m[1]).forEach((k) => keys.add(k));
    for (const m of text.matchAll(/\bCHECK[A-Z_]*\s*=\s*'([a-z_]+\.[a-z_]+)'/g)) keys.add(m[1]);
    for (const m of text.matchAll(/\bCHECK_KEYS\s*=\s*(?:Object\.freeze\(\s*)?\[([\s\S]*?)\]/g)) {
      quotedKeys(m[1]).forEach((k) => keys.add(k));
    }
    for (const m of text.matchAll(/\bCHECKS\s*=\s*(?:Object\.freeze\(\s*)?\{([\s\S]*?)\}/g)) {
      quotedKeys(m[1]).forEach((k) => keys.add(k));
    }
  }
  // contradictionPass.js: `const SEVERITY = Object.freeze({ kind: 'warning', … })`
  // and `checkKeyFor(kind) → 'context.' + kind`.
  const pass = code(read('services/operations/contradictionPass.js'));
  const severity = pass.match(/\bSEVERITY\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/);
  assert.ok(severity, 'contradictionPass.js no longer declares SEVERITY as the scan expects');
  assert.match(pass, /return `context\.\$\{kind\}`/, 'checkKeyFor no longer prefixes context.');
  for (const m of severity[1].matchAll(/^\s*([a-z_]+)\s*:/gm)) keys.add(`context.${m[1]}`);
  // …and every kind lib/drivers/context.js can actually emit, in case one is
  // added there and not to SEVERITY (it would still be filed, as context.<kind>).
  for (const kind of emittedContradictionKinds()) keys.add(`context.${kind}`);
  return keys;
}

/** The `kind:` values findContradictions (lib/drivers/context.js) returns. */
function emittedContradictionKinds() {
  const text = code(read('lib/drivers/context.js'));
  return [...new Set([...text.matchAll(/\bkind:\s*'([a-z_]+)'/g)].map((m) => m[1]))];
}

/** The kinds contradictionPass.js gives a severity. */
function severityKinds() {
  const pass = code(read('services/operations/contradictionPass.js'));
  const severity = pass.match(/\bSEVERITY\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/);
  return new Set([...severity[1].matchAll(/^\s*([a-z_]+)\s*:/gm)].map((m) => m[1]));
}

function labelledKeys() {
  const text = read('admin/src/pages/operations/labels.js');
  const body = text.slice(text.indexOf('const CHECK_LABELS = {'));
  const table = body.slice(0, body.indexOf('\n};'));
  return new Set([...table.matchAll(/^\s*'([a-z_]+\.[a-z_]+)':/gm)].map((m) => m[1]));
}

test('the scan finds the checks it is meant to (control)', () => {
  const keys = filedCheckKeys();
  // A literal, a constant, both branches of a ternary, a key declared only in
  // a CHECK_KEYS list, two from a CHECKS table and the three contradiction
  // kinds — every form the scan reads.
  assert.ok(keys.has('identity.duplicate_unit'));
  assert.ok(keys.has('home_time.board_disagrees_with_state'));
  assert.ok(keys.has('identity.status_disagreement'));
  assert.ok(keys.has('identity.status_needs_decision'));
  assert.ok(keys.has('home_time.clock_reset_on_group_change'));
  assert.ok(keys.has('identity.telegram_member_unnamed'));
  assert.ok(keys.has('identity.telegram_members_ambiguous'));
  // vehicleMatch.js files both of these through a lookup table, never as a
  // `checkKey:` literal; only its CHECK_KEYS list names them.
  assert.ok(keys.has('samsara.driver_name_mismatch'));
  assert.ok(keys.has('samsara.ambiguous_unit_match'));
  for (const kind of ['home_while_working', 'quiet_but_active', 'two_open_units']) {
    assert.ok(keys.has(`context.${kind}`), `context.${kind}`);
  }
  assert.ok(!keys.has('route_control.assignment_on_inactive_group'), 'a retired key is not a filed one');
  assert.ok(keys.size >= 25, `only ${keys.size} keys found — the scan is broken`);
});

test('every check the backend files has a plain name', () => {
  const labelled = labelledKeys();
  const missing = [...filedCheckKeys()].filter((k) => !labelled.has(k)).sort();
  assert.deepEqual(missing, [], 'add these to CHECK_LABELS in admin/src/pages/operations/labels.js');
});

test('every contradiction kind the context reader emits has a severity of its own', () => {
  // Without one, contradictionPass files it at the default severity, and
  // nothing says a new kind was never weighed.
  const emitted = emittedContradictionKinds();
  assert.ok(emitted.length >= 3, `only ${emitted.length} kinds found — the scan is broken`);
  const weighed = severityKinds();
  assert.deepEqual(emitted.filter((k) => !weighed.has(k)), []);
});
