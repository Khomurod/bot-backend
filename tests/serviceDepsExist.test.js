'use strict';

/**
 * Every method a service calls on its injected dependencies really exists.
 *
 * THE BUG THIS EXISTS FOR. `boardPresenceWatch` and `boardRoster` both called
 * `deps.boardSettings.getBoardConfig()`. No such function was ever
 * exported — the real one is `getBoardConfig` — but because the call goes
 * through a `deps` object rather than a named import, every static check passed:
 * `lint:undef` sees a property access, `lint:imports` sees no import to verify,
 * and every unit test stubbed `boardSettings` with whatever name the service
 * happened to use. It reached production and failed five times in a row before
 * anything said so.
 *
 * A DEPENDENCY OBJECT IS AN INTERFACE WITH NO COMPILER BEHIND IT, so this test
 * is the compiler. It reads each service's own source, finds every
 * `deps.<thing>.<method>(` it performs, and asserts that `defaultDeps()` really
 * provides it. Derived from the source rather than listed by hand, so it cannot
 * drift: a service that starts calling a new method is checked the moment it
 * does, without anybody remembering to update this file.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/** Services that build their collaborators with a `defaultDeps()` factory. */
const SERVICES = [
  '../services/homeTime/boardPresenceWatch',
  '../services/raise/boardRoster',
  '../services/homeTime/returnToRoadWatch',
];

/** Every `deps.<group>.<method>(` this source performs. */
function calledMethods(source) {
  const found = new Map();
  const re = /\bdeps\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/g;
  let m = re.exec(source);
  while (m) {
    const [, group, method] = m;
    if (!found.has(group)) found.set(group, new Set());
    found.get(group).add(method);
    m = re.exec(source);
  }
  return found;
}

for (const rel of SERVICES) {
  test(`${rel.split('/').pop()} calls only methods its real dependencies export`, () => {
    // eslint-disable-next-line global-require
    const mod = require(rel);
    assert.equal(typeof mod.defaultDeps, 'function', 'the service must expose defaultDeps()');
    const deps = mod.defaultDeps();
    const source = fs.readFileSync(path.resolve(__dirname, `${rel}.js`), 'utf8');

    const missing = [];
    for (const [group, methods] of calledMethods(source)) {
      const provided = deps[group];
      if (!provided) { missing.push(`deps.${group} is not provided at all`); continue; }
      for (const method of methods) {
        if (typeof provided[method] !== 'function') {
          missing.push(`deps.${group}.${method} is not a function on the real module`);
        }
      }
    }
    assert.deepEqual(missing, [], missing.join('\n'));
  });
}

test('the scanner really finds a deps call, so a green run means something', () => {
  const found = calledMethods('await deps.boardSettings.getBoardConfig(); deps.db.query(x);');
  assert.deepEqual([...found.keys()].sort(), ['boardSettings', 'db']);
  assert.deepEqual([...found.get('boardSettings')], ['getBoardConfig']);
});

test('the real Board settings module exports getBoardConfig and never the name that broke production', () => {
  // eslint-disable-next-line global-require
  const settings = require('../database/dispatchBoardSettings');
  assert.equal(typeof settings.getBoardConfig, 'function');
  assert.equal(settings.getDispatchBoardSettings, undefined,
    'if this ever exists, the two names have to be reconciled rather than both used');
});
