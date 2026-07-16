/**
 * Trailer Department navigation contract: one shared permission catalog, nested
 * under the main sidebar item, with the old horizontal tab bar gone.
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

const TRAILER_ONLY = ['trailers.view', 'trailer_rentals.view', 'trailer_map.view'];

test('the catalog defines every section with its documented permissions', async () => {
  const { TRAILER_SECTIONS } = await catalog();
  const byKey = Object.fromEntries(TRAILER_SECTIONS.map((s) => [s.key, s]));
  const expected = {
    dashboard: ['trailers.view'],
    rentals: ['trailer_rentals.view'],
    trailers: ['trailers.view'],
    companies: ['trailer_rentals.view', 'trailer_companies.manage'],
    payments: ['trailer_payments.view'],
    map: ['trailer_map.view'],
    reports: ['trailer_reports.view'],
    tracking: ['trailers.view'],
    settings: ['trailer_settings.manage'],
    users: ['trailer_users.manage'],
  };
  assert.deepEqual(TRAILER_SECTIONS.map((s) => s.key), Object.keys(expected));
  for (const [key, permissions] of Object.entries(expected)) {
    assert.deepEqual(byKey[key].permissions, permissions, `${key} permissions`);
  }
  assert.deepEqual(byKey.companies.label, 'Companies');
});

test('children are permission-filtered; full admins see all of them', async () => {
  const { permittedTrailerSections, TRAILER_SECTIONS } = await catalog();
  const trailerOnly = permittedTrailerSections(TRAILER_ONLY).map((s) => s.key);
  assert.deepEqual(trailerOnly, ['dashboard', 'rentals', 'trailers', 'companies', 'map', 'tracking']);
  assert.ok(!trailerOnly.includes('settings'), 'trailer-only users must not see Settings');
  assert.ok(!trailerOnly.includes('users'), 'trailer-only users must not see Trailer Users');

  const full = permittedTrailerSections(['admin.full_access']).map((s) => s.key);
  assert.deepEqual(full, TRAILER_SECTIONS.map((s) => s.key));
  assert.deepEqual(permittedTrailerSections([]), []);
});

test('either companies permission is enough for the Companies child', async () => {
  const { permittedTrailerSections } = await catalog();
  const keys = (permissions) => permittedTrailerSections(permissions).map((s) => s.key);
  assert.ok(keys(['trailer_rentals.view']).includes('companies'));
  assert.ok(keys(['trailer_companies.manage']).includes('companies'));
});

test('routes and active sections stay synchronized', async () => {
  const { trailerSectionPath, trailerSectionFromPath, defaultTrailerSection } = await catalog();
  assert.equal(trailerSectionPath('payments'), '/admin/trailers/payments');
  assert.equal(trailerSectionFromPath('/admin/trailers/payments'), 'payments');
  assert.equal(trailerSectionFromPath('/admin/trailers'), 'dashboard');
  // An unknown or stale deep link must not leave the sidebar without a match.
  assert.equal(trailerSectionFromPath('/admin/trailers/bogus'), 'dashboard');

  assert.equal(defaultTrailerSection(['admin.full_access']), 'dashboard');
  // Dashboard needs trailers.view — without it the first permitted child wins.
  assert.equal(defaultTrailerSection(['trailer_payments.view']), 'payments');
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

test('navigating to a child pushes /admin/trailers/{section}', () => {
  const app = read('App.jsx');
  assert.ok(/navigateToTrailerSection = \(sectionKey\) => \{/.test(app));
  assert.ok(/window\.history\.pushState\(\{\}, "", nextPath\)/.test(app));
  assert.ok(/trailerSectionPath\(sectionKey\)/.test(app));
  // Back/forward must resync both the page and the highlighted child.
  assert.ok(/setTrailerSection\(trailerSectionFromPath\(window\.location\.pathname\)\)/.test(app));
});
