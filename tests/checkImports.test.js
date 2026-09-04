/**
 * The missing-export scanner, and the false positives that nearly made it
 * useless.
 *
 * WHY THIS SCANNER EXISTS. `no-undef` catches a name that is used but never
 * declared. An import declares the name, so it catches nothing when the module
 * on the other side does not actually export it — the value is just
 * `undefined`, the build is green, and the failure waits for the first admin to
 * open the page. Same class as the 26 identifiers a module split left behind.
 *
 * WHY THE FIXTURES BELOW ARE SO PICKY. The scanner's first three runs each
 * reported findings that were all bogus, in three different ways: import
 * statements inside DOC COMMENTS and inside fixture code held in STRINGS were
 * read as real imports; `return /["\n]/.test(s)` was read as a division, which
 * turned the rest of csvSafe.js into string content and made it look like a
 * module exporting nothing; and a NESTED template literal flipped the string
 * parity in the Facebook connect pages, hiding their whole `module.exports`
 * block. Each of those is pinned here, because a gate that cries wolf is worse
 * than no gate at all.
 *
 * Fixture trees are throwaway directories: no database, no secrets, no network.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { findMissingImports } = require('../scripts/checkImports');
const { scrubNonCode } = require('../scripts/importScan/source');
const { readExports } = require('../scripts/importScan/surface');

/** Build a throwaway tree from a { 'rel/path': contents } map. */
function withTree(files, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'importscan-'));
  try {
    for (const [rel, contents] of Object.entries(files)) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, contents);
    }
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const names = (findings) => findings.map((f) => f.name).sort();

// ── it finds the real thing ──

test('an ESM import of a name the module does not export is reported', () => {
  withTree({
    'shaping.js': 'export function driverLabel() { return "x"; }\n',
    'table.jsx': 'import { driverLabel, getDaysUntilBirthday } from "./shaping";\nexport const x = [driverLabel, getDaysUntilBirthday];\n',
  }, (root) => {
    const findings = findMissingImports(root);
    assert.deepEqual(names(findings), ['getDaysUntilBirthday']);
    assert.equal(findings[0].file, 'table.jsx');
    assert.equal(findings[0].line, 1);
  });
});

test('the same import is clean once the export exists', () => {
  withTree({
    'shaping.js': 'export function driverLabel() {}\nexport function getDaysUntilBirthday() {}\n',
    'table.jsx': 'import { driverLabel, getDaysUntilBirthday } from "./shaping";\nexport const x = [driverLabel, getDaysUntilBirthday];\n',
  }, (root) => {
    assert.deepEqual(findMissingImports(root), []);
  });
});

test('a destructured require of a key the module does not export is reported', () => {
  withTree({
    'pool.js': "module.exports = { query };\nfunction query() {}\n",
    'questions.js': "const { pool, query } = require('./pool');\nmodule.exports = { pool, query };\n",
  }, (root) => {
    assert.deepEqual(names(findMissingImports(root)), ['pool']);
  });
});

test('a default import from a module without one is reported', () => {
  withTree({
    'helpers.js': 'export const a = 1;\n',
    'page.jsx': 'import helpers from "./helpers";\nexport const x = helpers;\n',
  }, (root) => {
    assert.deepEqual(names(findMissingImports(root)), ['default']);
  });
});

test('a relative path that resolves to nothing is reported', () => {
  withTree({
    'page.jsx': 'import { a } from "./gone";\nexport const x = a;\n',
  }, (root) => {
    assert.deepEqual(names(findMissingImports(root)), ['(module not found)']);
  });
});

// ── it stays quiet where it cannot know ──

test('a module whose exports include a spread is skipped, not guessed at', () => {
  withTree({
    'base.js': 'module.exports = { a: 1 };\n',
    'facade.js': "const base = require('./base');\nmodule.exports = { ...base, b: 2 };\n",
    'user.js': "const { a, b, anythingElse } = require('./facade');\nmodule.exports = { a, b, anythingElse };\n",
  }, (root) => {
    assert.deepEqual(findMissingImports(root), []);
  });
});

test('`module.exports = <value>` is unknowable, so nothing is reported', () => {
  withTree({
    'thing.js': 'class Thing {}\nmodule.exports = Thing;\n',
    'user.js': "const { whatever } = require('./thing');\nmodule.exports = { whatever };\n",
  }, (root) => {
    assert.deepEqual(findMissingImports(root), []);
  });
});

test('a star re-export chain is followed', () => {
  withTree({
    'deep.js': 'export const deepThing = 1;\n',
    'barrel.js': 'export * from "./deep";\n',
    'page.jsx': 'import { deepThing, missingThing } from "./barrel";\nexport const x = [deepThing, missingThing];\n',
  }, (root) => {
    assert.deepEqual(names(findMissingImports(root)), ['missingThing']);
  });
});

test('a CommonJS re-export of another module is followed', () => {
  withTree({
    'real.js': 'module.exports = { sortBySoonestBirthday: () => {} };\n',
    'compat.js': "module.exports = require('./real');\n",
    'user.js': "const { sortBySoonestBirthday, nope } = require('./compat');\nmodule.exports = { sortBySoonestBirthday, nope };\n",
  }, (root) => {
    assert.deepEqual(names(findMissingImports(root)), ['nope']);
  });
});

test('a ?raw import addresses the file, not its export surface', () => {
  withTree({
    'api.js': 'export const a = 1;\n',
    'page.jsx': 'import source from "./api.js?raw";\nexport const x = source;\n',
  }, (root) => {
    assert.deepEqual(findMissingImports(root), []);
  });
});

// ── the false positives, pinned ──

test('import statements inside comments and strings are not real imports', () => {
  withTree({
    'real.js': 'export const real = 1;\n',
    'page.jsx': [
      '/**',
      ' * Usage: import { notReal } from "./nowhere";',
      ' */',
      '// import { alsoNotReal } from "./nowhere";',
      'const fixture = "import { stringNotReal } from \'./nowhere\'";',
      'import { real } from "./real";',
      'export const x = [fixture, real];',
      '',
    ].join('\n'),
  }, (root) => {
    assert.deepEqual(findMissingImports(root), []);
  });
});

test('a regex after `return` does not swallow the rest of the file', () => {
  // The csvSafe.js bug: `return /["\n]/.test(s)` read as division, then the
  // quote inside the character class opened a string that ran to end of file.
  withTree({
    'csv.js': [
      "'use strict';",
      'function csvCell(value) {',
      '  const s = String(value);',
      '  return /[",\\n\\r]/.test(s) ? `"${s}"` : s;',
      '}',
      'module.exports = { csvCell };',
      '',
    ].join('\n'),
    'user.js': "const { csvCell } = require('./csv');\nmodule.exports = { csvCell };\n",
  }, (root) => {
    assert.deepEqual(findMissingImports(root), []);
  });
});

test('a nested template literal does not hide the export block', () => {
  // The Facebook connect-pages bug: an inner backtick inside `${…}` was read
  // as the outer closing backtick, flipping parity for everything after it.
  withTree({
    'pages.js': [
      'function render(rows) {',
      '  return `<div>${rows.length ? `<ul>${rows.join("")}</ul>` : \'\'}</div>`;',
      '}',
      'module.exports = { render };',
      '',
    ].join('\n'),
    'user.js': "const { render } = require('./pages');\nmodule.exports = { render };\n",
  }, (root) => {
    assert.deepEqual(findMissingImports(root), []);
  });
});

test('a comma inside a comment does not eat the export name beside it', () => {
  // database/driverProfiles.js: the key after a comment containing a comma
  // vanished, so its real consumer looked broken.
  withTree({
    'profiles.js': [
      'function normalizeTelegramUserId() {}',
      'module.exports = {',
      '  // internal normalizer shared with groupMembers.js (not part of the legacy',
      '  // db.js surface, but harmless to expose)',
      '  normalizeTelegramUserId,',
      '};',
      '',
    ].join('\n'),
    'members.js': "const { normalizeTelegramUserId } = require('./profiles');\nmodule.exports = { normalizeTelegramUserId };\n",
  }, (root) => {
    assert.deepEqual(findMissingImports(root), []);
  });
});

test('scrubbing preserves every offset, so reported lines stay correct', () => {
  const source = [
    '// a comment',
    'const s = "a string";',
    'const re = /["\\n]/;',
    'const t = `outer ${`inner ${1}`} end`;',
    'export const x = [s, re, t];',
    '',
  ].join('\n');
  const scrubbed = scrubNonCode(source);
  assert.equal(scrubbed.length, source.length, 'length must be preserved');
  assert.equal(scrubbed.split('\n').length, source.split('\n').length, 'lines must be preserved');
  assert.match(scrubbed, /export const x = \[s, re, t\];/, 'real code survives');
  assert.doesNotMatch(scrubbed, /a comment|a string/, 'comments and string bodies are blanked');
});

// ── the real repository ──

test('the repository itself has no import naming a missing export', () => {
  const findings = findMissingImports();
  assert.deepEqual(
    findings,
    [],
    `broken imports:\n${findings.map((f) => `  ${f.file}:${f.line} ${f.name} from ${f.specifier}`).join('\n')}`,
  );
});

test('the scanner can read the real modules that broke it', () => {
  // Regression sentinels against the live files, not just fixtures.
  const root = path.join(__dirname, '..');
  const csv = readExports(path.join(root, 'server/routes/csvSafe.js'));
  assert.ok(csv.names.has('toCsv') && csv.names.has('csvCell'), 'csvSafe exports read');
  const pages = readExports(path.join(root, 'server/routes/facebookConnect/connectPages.js'));
  assert.ok(pages.names.has('renderPagePicker'), 'connectPages exports read');
  const profiles = readExports(path.join(root, 'database/driverProfiles.js'));
  assert.ok(profiles.names.has('normalizeTelegramUserId'), 'driverProfiles exports read');
});

test('npm test and CI both run this scanner', () => {
  const root = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.match(pkg.scripts['lint:imports'] || '', /checkImports/);
  assert.match(pkg.scripts.test || '', /lint:imports/, 'npm test must run it');
  const ci = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(ci, /npm run lint:imports/, 'CI must run it');
});
