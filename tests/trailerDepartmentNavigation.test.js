/**
 * Trailer Department navigation contract: FIVE destinations (Home, Rentals,
 * Trailers, Money, More), one shared permission catalog, nested under the main
 * sidebar item, with every pre-redesign section key still routing somewhere.
 *
 * The catalog is dependency-free ESM, so its behaviour is tested for real. The
 * JSX around it is verified as a source contract — the admin project has no
 * component-test runner, and the Vite build covers JSX/module validity.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ADMIN = path.resolve(__dirname, '../admin/src');
const read = (relative) => fs.readFileSync(path.join(ADMIN, relative), 'utf8');
const catalog = () => import(pathToFileURL(path.join(ADMIN, 'pages/trailer/trailerNavigation.js')).href);

test('the catalog defines every section with its documented permissions', async () => {
  const { TRAILER_SECTIONS } = await catalog();
  const byKey = Object.fromEntries(TRAILER_SECTIONS.map((s) => [s.key, s]));
  const expected = {
    home: ['trailers.view', 'trailer_rentals.view', 'trailer_payments.view'],
    rentals: ['trailer_rentals.view', 'trailer_agreements.view'],
    trailers: ['trailers.view'],
    money: ['trailer_payments.view'],
    more: ['trailer_companies.manage', 'trailer_imports.manage', 'trailer_reports.view',
      'trailer_settings.manage', 'trailer_users.manage'],
  };
  assert.deepEqual(TRAILER_SECTIONS.map((s) => s.key), Object.keys(expected));
  for (const [key, permissions] of Object.entries(expected)) {
    assert.deepEqual(byKey[key].permissions, permissions, `${key} permissions`);
  }
  assert.equal(byKey.home.label, 'Home');
  assert.equal(byKey.more.label, 'More');
});

test('role presets emerge from permissions — no inaccessible items rendered', async () => {
  const { permittedTrailerSections, TRAILER_SECTIONS } = await catalog();
  const keys = (permissions) => permittedTrailerSections(permissions).map((s) => s.key);

  // Employee: works rentals and trailers.
  assert.deepEqual(keys(['trailers.view', 'trailer_rentals.view', 'trailer_inspections.manage']),
    ['home', 'rentals', 'trailers']);
  // Accounting: money-focused.
  assert.deepEqual(keys(['trailer_payments.view', 'trailer_payments.record']), ['home', 'money']);
  // Manager permissions unlock More.
  assert.ok(keys(['trailer_settings.manage']).includes('more'));
  assert.ok(!keys(['trailers.view']).includes('more'), 'non-managers must not see More');
  // Full admins see everything; nobody gets an empty ghost menu.
  assert.deepEqual(keys(['admin.full_access']), TRAILER_SECTIONS.map((s) => s.key));
  assert.deepEqual(permittedTrailerSections([]), []);
});

test('every legacy section key routes to its new destination', async () => {
  const { trailerSectionFromPath, trailerLegacyTab, TRAILER_LEGACY_SECTIONS } = await catalog();
  const expected = {
    dashboard: ['home', null],
    agreements: ['rentals', null],
    payments: ['money', null],
    map: ['trailers', 'map'],
    tracking: ['trailers', 'updates'],
    mentions: ['trailers', 'updates'],
    masterImport: ['more', 'trailer-list'],
    companies: ['more', 'companies'],
    reports: ['more', 'reports'],
    settings: ['more', 'settings'],
    users: ['more', 'team'],
  };
  assert.deepEqual(Object.keys(TRAILER_LEGACY_SECTIONS).sort(), Object.keys(expected).sort());
  for (const [legacy, [section, tab]] of Object.entries(expected)) {
    assert.equal(trailerSectionFromPath(`/admin/trailers/${legacy}`), section, `${legacy} section`);
    assert.equal(trailerLegacyTab(`/admin/trailers/${legacy}`), tab, `${legacy} tab`);
  }
});

test('routes and active sections stay synchronized', async () => {
  const { trailerSectionPath, trailerSectionFromPath, defaultTrailerSection } = await catalog();
  assert.equal(trailerSectionPath('money'), '/trailers/money');
  assert.equal(trailerSectionFromPath('/trailers/money'), 'money');
  assert.equal(trailerSectionFromPath('/trailers'), 'home');
  // An unknown or stale deep link must not leave the sidebar without a match.
  assert.equal(trailerSectionFromPath('/trailers/bogus'), 'home');

  assert.equal(defaultTrailerSection(['admin.full_access']), 'home');
  // Home needs a view permission — without one the first permitted section wins.
  assert.equal(defaultTrailerSection(['trailer_settings.manage']), 'more');
});

test('/trailers is the canonical slug and /admin/trailers still resolves', async () => {
  const {
    TRAILER_BASE_PATH, TRAILER_LEGACY_BASE_PATH,
    isTrailerPath, isLegacyTrailerPath, trailerSectionFromPath,
  } = await catalog();
  assert.equal(TRAILER_BASE_PATH, '/trailers');
  assert.equal(TRAILER_LEGACY_BASE_PATH, '/admin/trailers');

  for (const path of ['/trailers', '/trailers/money', '/admin/trailers', '/admin/trailers/money']) {
    assert.ok(isTrailerPath(path), `${path} must be recognized as a department path`);
  }
  // Nothing else may be swallowed — /admin and the tracking page are separate.
  for (const path of ['/admin', '/admin/users', '/dispatch', '/questions', '/', '']) {
    assert.ok(!isTrailerPath(path), `${path} must not be treated as a department path`);
  }

  assert.ok(isLegacyTrailerPath('/admin/trailers/money'));
  assert.ok(!isLegacyTrailerPath('/trailers/money'));
  // Both prefixes parse to the same section.
  assert.equal(trailerSectionFromPath('/admin/trailers/money'), 'money');
  assert.equal(trailerSectionFromPath('/trailers/money'), 'money');
});

test('a legacy URL is canonicalized without losing section, tab, or filters', async () => {
  const { canonicalTrailerUrl } = await catalog();

  assert.equal(canonicalTrailerUrl('/admin/trailers'), '/trailers/home');
  assert.equal(canonicalTrailerUrl('/admin/trailers/money'), '/trailers/money');
  // A legacy section key becomes its new section PLUS the sub-tab it meant.
  assert.equal(canonicalTrailerUrl('/admin/trailers/map'), '/trailers/trailers?tab=map');
  assert.equal(canonicalTrailerUrl('/admin/trailers/companies'), '/trailers/more?tab=companies');
  // The selected record and every filter survive the rewrite.
  assert.equal(
    canonicalTrailerUrl('/admin/trailers/map', '?trailer=42&status=active'),
    '/trailers/trailers?trailer=42&status=active&tab=map',
  );
  assert.equal(
    canonicalTrailerUrl('/admin/trailers/payments', '?invoice=7'),
    '/trailers/money?invoice=7',
  );
  // An explicit ?tab= wins over the one the legacy key implies.
  assert.equal(canonicalTrailerUrl('/admin/trailers/map', '?tab=list'), '/trailers/trailers?tab=list');
  // Already-canonical URLs are stable (idempotent rewrite).
  assert.equal(canonicalTrailerUrl('/trailers/money', '?invoice=7'), '/trailers/money?invoice=7');
  // Not a department path at all.
  assert.equal(canonicalTrailerUrl('/admin/users'), null);
});

test('the old horizontal Trailer Department navigation is gone', () => {
  const shell = read('pages/trailer/TrailerDepartmentShell.jsx');
  assert.ok(!/<nav>/.test(shell), 'the horizontal tab bar must be removed from the shell');
  assert.ok(!/window\.history\.pushState/.test(shell), 'the shell must not own router state');
  assert.ok(!/const ITEMS\s*=/.test(shell), 'the shell must not keep its own section list');

  const css = read('pages/trailer/trailerDepartment.css');
  assert.ok(!/\.trailer-department-brand nav/.test(css), 'tab-bar styles must be removed');
  assert.ok(/\.trailer-report-tabs button/.test(css), 'report tabs must keep their styling');
});

test('the shell renders the section chosen by the sidebar', () => {
  const shell = read('pages/trailer/TrailerDepartmentShell.jsx');
  assert.ok(/function TrailerDepartmentShell\(\{\s*section,\s*onNavigate\s*\}\)/.test(shell));
  assert.ok(/permittedTrailerSections/.test(shell), 'the shell must use the shared catalog');
});

test('the sidebar nests permitted children under Trailer Department', () => {
  const sidebar = read('components/AdminSidebar.jsx');
  const operations = sidebar.split("label: 'Operations'")[1].split("label: 'Communications'")[0];
  assert.ok(/key: 'trailer_department', icon: '🏢', label: 'Trailer Department'/.test(operations),
    'Trailer Department must stay in the Operations section');
  assert.ok(/permittedTrailerSections\(session\?\.permissions\)/.test(sidebar),
    'the sidebar must filter children through the shared catalog');
  assert.ok(/<TrailerNavItem/.test(sidebar), 'the department item must render its children');

  const app = read('App.jsx');
  assert.ok(/<TrailerDepartmentShell\s+section=\{trailerSection\}/.test(app),
    'the active section must be passed into the shell');
  assert.ok(/setMobileMenuOpen\(false\)/.test(app), 'navigation must close the mobile drawer');

  const item = read('components/TrailerNavItem.jsx');
  assert.ok(/aria-expanded=\{expanded\}/.test(item), 'the expand control must expose aria-expanded');
  assert.ok(/nav-subitem/.test(item), 'children must render as indented sub-items');
});

test('navigating to a child pushes /trailers/{section}', () => {
  const app = read('App.jsx');
  assert.ok(/navigateToTrailerSection = \(sectionKey/.test(app));
  assert.ok(/window\.history\.pushState\(\{\}, "", nextPath\)/.test(app));
  assert.ok(/trailerSectionPath\(sectionKey\)/.test(app));
  // Back/forward must resync both the page and the highlighted child.
  assert.ok(/setTrailerSection\(trailerSectionFromPath\(window\.location\.pathname\)\)/.test(app));
  // A bookmarked /admin/trailers URL is rewritten in place, never pushed.
  assert.ok(/normalizeTrailerUrl\(\)/.test(app), 'the legacy prefix must be normalized on entry');
  assert.ok(/window\.history\.replaceState\(\{\}, "", next\)/.test(app),
    'the rewrite must replace the entry so Back does not bounce');
});

test('the server serves the SPA for /trailers deep links and refreshes', () => {
  const api = fs.readFileSync(path.resolve(__dirname, '../server/api.js'), 'utf8');
  const catchAll = api.split('Catch-all for admin SPA')[1].split('\n})')[0];
  for (const route of ["'/trailers'", "'/trailers/*'", "'/admin'", "'/admin/*'"]) {
    assert.ok(catchAll.includes(route), `${route} must reach the SPA index.html`);
  }
  assert.ok(catchAll.includes('adminSpaIndexPath'), 'the catch-all must send the built index.html');
});

test('the server home links point at the canonical /trailers slug', () => {
  const home = fs.readFileSync(path.resolve(__dirname, '../services/trailerHomeService.js'), 'utf8');
  const links = home.split('const LINKS = {')[1].split('};')[0];
  assert.ok(!/\/admin\/trailers/.test(links), 'attention links must use the /trailers slug');
  assert.ok(/'\/trailers\/rentals\?tab=upcoming_pickups'/.test(links));
});
