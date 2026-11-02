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

function filedCheckKeys() {
  const keys = new Set();
  const patterns = [
    /checkKey:\s*'([a-z_]+\.[a-z_]+)'/g,
    /\bCHECK[A-Z_]*\s*=\s*'([a-z_]+\.[a-z_]+)'/g,
  ];
  for (const rel of ['services', 'lib', 'database', 'bot', 'server'].flatMap((d) => sources(d))) {
    const text = code(read(rel));
    for (const re of patterns) for (const m of text.matchAll(re)) keys.add(m[1]);
  }
  return keys;
}

function labelledKeys() {
  const text = read('admin/src/pages/operations/labels.js');
  const body = text.slice(text.indexOf('const CHECK_LABELS = {'));
  const table = body.slice(0, body.indexOf('\n};'));
  return new Set([...table.matchAll(/^\s*'([a-z_]+\.[a-z_]+)':/gm)].map((m) => m[1]));
}

test('the scan finds the checks it is meant to (control)', () => {
  const keys = filedCheckKeys();
  // One literal and one constant, from two different services.
  assert.ok(keys.has('identity.duplicate_unit'));
  assert.ok(keys.has('home_time.board_disagrees_with_state'));
  assert.ok(keys.size >= 25, `only ${keys.size} keys found — the scan is broken`);
});

test('every check the backend files has a plain name', () => {
  const labelled = labelledKeys();
  const missing = [...filedCheckKeys()].filter((k) => !labelled.has(k)).sort();
  assert.deepEqual(missing, [], 'add these to CHECK_LABELS in admin/src/pages/operations/labels.js');
});
