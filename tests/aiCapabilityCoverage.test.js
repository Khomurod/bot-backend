/**
 * THE SWITCH MUST COVER EVERYTHING IT CLAIMS TO COVER.
 *
 * `services/ai/router.js` refuses a capability an administrator switched off —
 * but only when the call actually carries one. An untagged call skips the gate
 * entirely and keeps reaching the provider, which turns Settings → AI into a
 * screen that lies: the responsibility reads "off" and the prompts keep going.
 *
 * Four call sites were exactly that when this was written, including the second
 * of two calls in a file whose FIRST call was tagged — the failure mode a
 * per-file review misses and a scanner does not. So this test is a scan of the
 * source rather than a list someone has to remember to extend: every routed
 * call must name a capability, and every capability it names must be in the
 * catalogue the admin screen renders.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { CAPABILITIES } = require('../lib/ai/capabilityCatalog');

const ROOT = path.resolve(__dirname, '..');
const SEARCH_DIRS = ['services', 'server', 'lib'];

/** The three functions that reach the router. */
const ROUTED_CALL = /\b(callGeminiText|callGeminiJson|callGroqWithFallback)\s*\(/g;

/** The clients themselves, and the router: they define the seam, not use it. */
const NOT_CALLERS = new Set([
  'services/geminiClient.js',
  'services/groqClient.js',
  'services/ai/router.js',
]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The capability keys a file mentions, in any of the two shapes used here:
 * an inline `capability: 'x'` and a `const CAPABILITY = 'x'` constant.
 */
function capabilityKeysIn(source) {
  const keys = new Set();
  for (const m of source.matchAll(/capability:\s*'([a-z0-9_]+)'/g)) keys.add(m[1]);
  for (const m of source.matchAll(/CAPABILITY\s*=\s*'([a-z0-9_]+)'/g)) keys.add(m[1]);
  return keys;
}

/** One entry per routed call site found in the tree. */
function routedCallSites() {
  const sites = [];
  for (const dir of SEARCH_DIRS) {
    for (const file of walk(path.join(ROOT, dir))) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      if (NOT_CALLERS.has(rel)) continue;
      const source = fs.readFileSync(file, 'utf8');
      const calls = [...source.matchAll(ROUTED_CALL)].filter((m) => {
        const line = source.slice(
          source.lastIndexOf('\n', m.index) + 1,
          (source.indexOf('\n', m.index) + 1 || source.length) - 1
        );
        // Only an import names the function without calling it. Excluding
        // every line starting `const` would have skipped
        // `const { text } = await callGroqWithFallback(...)` — which is how the
        // first version of this scanner missed three of the four real gaps.
        return !/require\(/.test(line);
      });
      if (!calls.length) continue;
      sites.push({ rel, calls: calls.length, keys: capabilityKeysIn(source) });
    }
  }
  return sites;
}

test('every routed AI call names a capability, so the switch reaches it', () => {
  const untagged = routedCallSites().filter((s) => s.keys.size === 0);
  assert.deepEqual(untagged.map((s) => s.rel), [],
    'these files call the router with no capability, so switching the responsibility '
    + 'off in Settings → AI would change nothing for them');
});

test('a file with several routed calls tags EVERY one of them', () => {
  // The real defect this catches: homeTimeMessageComposer tagged its first call
  // and not its second, so the file looked covered and half of it was not.
  const offenders = [];
  for (const dir of SEARCH_DIRS) {
    for (const file of walk(path.join(ROOT, dir))) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      if (NOT_CALLERS.has(rel)) continue;
      const source = fs.readFileSync(file, 'utf8');
      for (const line of source.split('\n')) {
        if (!/\bawait\s+(callGeminiText|callGeminiJson|callGroqWithFallback)\s*\(/.test(line)) continue;
        // Either the options object opens on this line and the capability
        // follows within the call, or the whole call is on one line. Simplest
        // reliable rule: the call must not be a bare `(prompt)` or `({ ... })`
        // that closes on the same line without a capability.
        const closesHere = /\)\s*;?\s*$/.test(line) && !/\{\s*$/.test(line);
        if (closesHere && !/capability/.test(line)) offenders.push(`${rel}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    'a single-line routed call with no capability in it skips the gate');
});

test('every capability a call site names exists in the catalogue the admin renders', () => {
  const known = new Set(CAPABILITIES.map((c) => c.key));
  const unknown = [];
  for (const site of routedCallSites()) {
    for (const key of site.keys) if (!known.has(key)) unknown.push(`${site.rel}: ${key}`);
  }
  assert.deepEqual(unknown, [],
    'a capability the router honours but the catalogue omits is a switch nobody can see');
});

test('the catalogue describes each responsibility well enough to judge the switch', () => {
  for (const c of CAPABILITIES) {
    assert.ok(c.label && c.label.length > 3, `${c.key}: needs a human label`);
    assert.ok(c.what && c.what.length > 15, `${c.key}: needs to say what it decides`);
    assert.ok(c.fallback, `${c.key}: must say what happens with AI off, or the switch is unjudgeable`);
    assert.ok(c.group, `${c.key}: needs a group`);
    if (c.changesState) {
      assert.ok(c.stateNote, `${c.key}: changes state, so it must say what it writes`);
    }
  }
});
