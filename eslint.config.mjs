/**
 * Repository lint config — deliberately narrow.
 *
 * ONLY BUGS ARE ERRORS HERE. Every enabled rule reports something that is
 * broken at runtime, never a matter of style, so a report from this config is
 * always worth acting on. `no-undef` is the reason it exists; `no-const-assign`
 * is the reason it grew (see CORRECTNESS_RULES).
 *
 * WHY THIS EXISTS. A module-splitting refactor moved functions into new files
 * and left 26 of their identifiers behind — `getDaysUntilBirthday` in the
 * Driver Groups shaping module, `activeRun` in the mileage-bonus scheduler, and
 * 24 more. `vite build` passed every time, because a bundler treats an
 * unresolved module-scope name as a global and defers the failure to runtime.
 * The admin panel then threw ReferenceError the moment each page opened, and
 * the mileage-bonus tick threw on every scheduled pass. Six older bugs of the
 * same shape were found alongside them, one on the main broadcast send path.
 *
 * A build is not a scope check. This is the scope check, and it runs in
 * `npm test` and in CI so the class cannot ship again.
 *
 * COVERAGE IS A DENY-LIST, NOT AN ALLOW-LIST. The first version of this file
 * listed the directories to lint, and ten hand-written files sat outside that
 * list unchecked — the three `.mjs` helpers under `admin/src/pages`, both
 * modules in `utils/`, and all four browser scripts in `server/qbq/public`
 * (named in `ignores`, so the block that claimed to lint them never applied).
 * That is the same blind spot the file-size scanner had before it was inverted.
 * Everything is linted now, and `tests/checkUndefined.test.js` asserts that
 * every hand-written JS file the repository contains has `no-undef` in force,
 * so a new directory is covered the moment it is created.
 *
 * Style rules are deliberately absent: this file is a correctness gate, not a
 * formatter, and a noisy gate is one people learn to ignore.
 */
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * Rules that only ever fire on a real defect.
 *
 * `no-undef` catches the class that broke production: 26 identifiers a module
 * split left behind.
 *
 * `no-const-assign` catches its sibling, which broke the live map the same way
 * and was found while fixing the first. services/liveLocations/caches.js
 * exported four `let` cache slots BY VALUE; snapshot.js destructured them —
 * binding consts — and then assigned to them, so every uncached dispatch-map
 * request died on "Assignment to constant variable" and the TTL cache that
 * exists to spare the database never held anything.
 *
 * The rest are the same shape: silently dropped duplicate keys, a comparison
 * that can never be true, a `typeof` misspelling, code after a `return`. None
 * of them can be argued with, and none of them fires on working code — the
 * repository was clean on all of them at the moment they were added, except
 * for one genuinely unreachable line.
 */
const CORRECTNESS_RULES = {
  'no-undef': 'error',
  'no-const-assign': 'error',
  'no-class-assign': 'error',
  'no-func-assign': 'error',
  'no-import-assign': 'error',
  'no-dupe-args': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-class-members': 'error',
  'no-duplicate-case': 'error',
  'no-self-assign': 'error',
  'no-obj-calls': 'error',
  'no-unreachable': 'error',
  'no-sparse-arrays': 'error',
  'no-unsafe-negation': 'error',
  'no-compare-neg-zero': 'error',
  'no-constant-binary-expression': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
};

/**
 * The two trees that run in a browser rather than in Node. They are configured
 * by their own blocks below and excluded from the Node base so that Node
 * globals do not leak into browser code (flat-config `globals` merge).
 */
const BROWSER_TREES = [
  'admin/**/*.{js,jsx,mjs}',
  'server/qbq/public/**/*.js',
];

export default [
  {
    // The one real signal here is an undefined identifier. Unused-directive
    // warnings (24 of them, all `no-await-in-loop` in the Pg suites) would bury
    // it, and a gate people skim is not a gate.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
  },
  {
    ignores: [
      '**/node_modules/**',
      'admin/build/**',
      'coverage/**',
      // Python.
      'leads-bot/**',
      '**/*.min.js',
    ],
  },
  {
    // BASE — every hand-written file outside the browser trees. Node, CommonJS:
    // the runtime for the bot, the API server, services, database, lib, utils,
    // scripts and tests.
    files: ['**/*.{js,jsx,cjs,mjs}'],
    ignores: BROWSER_TREES,
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.es2021 },
    },
    rules: { ...CORRECTNESS_RULES },
  },
  {
    // `.mjs` is ES modules wherever it lives.
    files: ['**/*.mjs'],
    ignores: BROWSER_TREES,
    languageOptions: { sourceType: 'module' },
  },
  {
    // The admin panel: ES modules + JSX in a browser. `admin/**` rather than
    // `admin/src/**` so a new folder beside `src` is not silently unchecked.
    files: ['admin/**/*.{js,jsx,mjs}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.es2021 },
    },
    rules: {
      ...CORRECTNESS_RULES,
      // Registered so existing disable directives resolve; intentionally off.
      'react-hooks/exhaustive-deps': 'off',
      'react-hooks/rules-of-hooks': 'off',
    },
  },
  {
    // Vite/Vitest config files sit inside admin/ but run in Node.
    files: ['admin/vite.config.js', 'admin/vitest.config.js', 'admin/vitest.setup.js'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // Test files add the runner's globals. Node's built-in runner needs none of
    // these, but the admin suite runs under Vitest.
    files: ['admin/**/*.test.{js,jsx}', 'admin/vitest.setup.js'],
    languageOptions: {
      globals: {
        describe: 'readonly', it: 'readonly', test: 'readonly', expect: 'readonly',
        vi: 'readonly', beforeEach: 'readonly', afterEach: 'readonly',
        beforeAll: 'readonly', afterAll: 'readonly', suite: 'readonly',
      },
    },
  },
  {
    // Scripts served to the browser from the QBQ pages: browser globals, and
    // classic scripts rather than modules.
    files: ['server/qbq/public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globals.browser, ...globals.es2021 },
    },
    rules: { ...CORRECTNESS_RULES },
  },
];
