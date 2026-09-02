/**
 * The file-size scanner is the only thing standing between the repository and a
 * slow return of 1000-line modules, so its COVERAGE is the thing under test
 * here, not just its arithmetic.
 *
 * Two earlier blind spots motivate these tests. The scanner used to walk a
 * hard-coded list of included directories: `leads-bot/` and its Python were
 * invisible, and so were `admin/vite.config.js` and its siblings sitting one
 * level above `admin/src`. Both were real hand-written files exempt from a rule
 * that claims to cover every hand-written file. The scanner now walks from the
 * repository root and skips only provably machine-produced paths, so the tests
 * below assert that a NEW directory of hand-written code is covered the moment
 * it exists — with no list for anyone to remember to update.
 *
 * The fixture trees are throwaway directories, so these run with no database,
 * no secrets and no network.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  LIMIT,
  countLines,
  isSourceFile,
  collectSourceFiles,
  findOversized,
  enforce,
} = require('../scripts/checkFileSize');

/** Build a throwaway tree from a { 'rel/path': contents } map. */
function makeTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'filesize-'));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
  }
  return root;
}

/** A file body of exactly `n` physical lines. */
const linesOf = (n) => `${Array.from({ length: n }, (_, i) => `// line ${i + 1}`).join('\n')}\n`;

function withTree(files, fn) {
  const root = makeTree(files);
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function silenced(fn) {
  const { log, error } = console;
  console.log = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
    console.error = error;
  }
}

// ── the limit itself ──

test('the limit is 500 physical lines', () => {
  assert.equal(LIMIT, 500);
});

test('exactly at the limit passes; one line over fails', () => {
  withTree({ 'a.js': linesOf(500), 'b.js': linesOf(501) }, (root) => {
    const over = Object.fromEntries(findOversized(root));
    assert.equal(over['a.js'], undefined, '500 lines is allowed');
    assert.equal(over['b.js'], 501, '501 lines is a violation');
  });
});

test('countLines matches wc -l intent regardless of trailing newline', () => {
  withTree({
    'trailing.js': 'a\nb\nc\n',
    'no-trailing.js': 'a\nb\nc',
    'empty.js': '',
    'crlf.js': 'a\r\nb\r\n',
  }, (root) => {
    assert.equal(countLines(path.join(root, 'trailing.js')), 3);
    assert.equal(countLines(path.join(root, 'no-trailing.js')), 3);
    assert.equal(countLines(path.join(root, 'empty.js')), 0);
    assert.equal(countLines(path.join(root, 'crlf.js')), 2, 'CRLF counts as one newline');
  });
});

// ── coverage: hand-written code cannot escape ──

test('a brand-new top-level directory is scanned without touching the scanner', () => {
  // The regression that motivated the deny-list design: inventing a directory
  // must not create an exemption.
  withTree({
    'brand-new-area/huge.js': linesOf(700),
    'another/nested/deeply/also-huge.py': linesOf(600),
  }, (root) => {
    const over = Object.fromEntries(findOversized(root));
    assert.equal(over['brand-new-area/huge.js'], 700);
    assert.equal(over['another/nested/deeply/also-huge.py'], 600);
  });
});

test('config files beside a src/ directory are scanned, not just src/ itself', () => {
  // admin/vite.config.js, admin/vitest.config.js and admin/vitest.setup.js were
  // invisible while the scanner only walked admin/src.
  withTree({
    'admin/vite.config.js': linesOf(510),
    'admin/vitest.config.js': linesOf(10),
    'admin/vitest.setup.js': linesOf(10),
    'admin/src/pages/Page.jsx': linesOf(10),
  }, (root) => {
    const files = collectSourceFiles(root);
    assert.ok(files.includes('admin/vite.config.js'));
    assert.ok(files.includes('admin/vitest.config.js'));
    assert.ok(files.includes('admin/vitest.setup.js'));
    assert.ok(files.includes('admin/src/pages/Page.jsx'));
    assert.deepEqual(findOversized(root), [['admin/vite.config.js', 510]]);
  });
});

test('repository-root entry points are scanned', () => {
  withTree({ 'index.js': linesOf(520), 'setup.mjs': linesOf(10) }, (root) => {
    const files = collectSourceFiles(root);
    assert.ok(files.includes('index.js'), 'root index.js is hand-written code');
    assert.ok(files.includes('setup.mjs'));
    assert.deepEqual(findOversized(root), [['index.js', 520]]);
  });
});

test('every source extension is covered, including Python and TypeScript', () => {
  withTree({
    'a.js': linesOf(501), 'b.mjs': linesOf(502), 'c.cjs': linesOf(503),
    'd.jsx': linesOf(504), 'e.ts': linesOf(505), 'f.tsx': linesOf(506),
    'g.py': linesOf(507),
  }, (root) => {
    assert.equal(findOversized(root).length, 7, 'all seven extensions enforced');
  });
});

// ── exclusions: only machine-produced paths are skipped ──

test('installed dependencies, build output and caches are skipped', () => {
  withTree({
    'node_modules/pkg/index.js': linesOf(9000),
    'admin/node_modules/pkg/index.js': linesOf(9000),
    'build/main.js': linesOf(9000),
    'admin/build/assets/app.js': linesOf(9000),
    'dist/out.js': linesOf(9000),
    'coverage/lcov-report/block.js': linesOf(9000),
    'leads-bot/__pycache__/mod.cpython-311.py': linesOf(9000),
    '.venv/lib/site.py': linesOf(9000),
    'vendor/lib.js': linesOf(9000),
    'kept.js': linesOf(10),
  }, (root) => {
    assert.deepEqual(collectSourceFiles(root), ['kept.js']);
    assert.deepEqual(findOversized(root), [], 'no generated path is enforced');
  });
});

test('minified and generated bundles are skipped; ordinary files are not', () => {
  withTree({
    'a.min.js': linesOf(9000),
    'b.bundle.js': linesOf(9000),
    'c.generated.ts': linesOf(9000),
    'legit.min-width.js': linesOf(600),
  }, (root) => {
    assert.equal(isSourceFile('a.min.js'), false);
    assert.equal(isSourceFile('b.bundle.js'), false);
    assert.equal(isSourceFile('c.generated.ts'), false);
    assert.equal(isSourceFile('legit.min-width.js'), true, 'only a real .min.js suffix is exempt');
    assert.deepEqual(findOversized(root), [['legit.min-width.js', 600]]);
  });
});

test('non-code files are out of scope', () => {
  withTree({
    'notes.md': linesOf(9000),
    'styles.css': linesOf(9000),
    'data.json': linesOf(9000),
    'schema.sql': linesOf(9000),
    'code.js': linesOf(10),
  }, (root) => {
    assert.deepEqual(collectSourceFiles(root), ['code.js']);
  });
});

// ── the enforcing entry point ──

test('enforce() exits non-zero on a violation and zero when clean', () => {
  withTree({ 'ok.js': linesOf(500) }, (root) => {
    assert.equal(silenced(() => enforce(root)), 0, 'clean tree passes');
  });
  withTree({ 'bad.js': linesOf(501) }, (root) => {
    assert.equal(silenced(() => enforce(root)), 1, 'a single violation fails CI');
  });
});

test('there is no baseline or exemption file to launder a violation through', () => {
  // The old design let a violation be recorded in scripts/fileSizeBaseline.json.
  // Enforcement now reads nothing but the tree, so a stray file cannot re-open it.
  assert.equal(
    fs.existsSync(path.join(__dirname, '..', 'scripts', 'fileSizeBaseline.json')),
    false,
    'the baseline file is gone; do not reintroduce it',
  );
  withTree({
    'bad.js': linesOf(600),
    'scripts/fileSizeBaseline.json': JSON.stringify({ files: { 'bad.js': 600 } }),
  }, (root) => {
    assert.deepEqual(findOversized(root), [['bad.js', 600]], 'a baseline file is ignored');
  });
});

// ── the real repository ──

test('the repository itself has no file over the limit', () => {
  const rows = findOversized();
  assert.deepEqual(
    rows,
    [],
    `oversized files:\n${rows.map(([f, n]) => `  ${n}  ${f}`).join('\n')}`,
  );
});
