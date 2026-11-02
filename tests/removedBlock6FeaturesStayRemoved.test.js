'use strict';

/**
 * Block 6 of the hidden-functions audit stays done (November 2026).
 *
 * - The Datatruck peer reactions: 👍/🔥 on @datatruck_driver_bot's load posts
 *   and a model-written joke on its errors. Nobody relied on it.
 * - The Indeed lead intake: a Gmail Apps Script posting Indeed emails to
 *   `POST /api/internal/indeed/lead`, and `pdf-parse`, which only it used.
 *   The `leads` rows it recorded stay, and the Leads page still labels them.
 * - The hub's short `/health` alias, kept for a cron pinger that woke the old
 *   Render instance. `/api/health` stays: the container's HEALTHCHECK uses it.
 *
 * The routes are proven 404 in tests/api-surface.test.js; this holds the
 * modules, the settings, the dependency and the documents.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
// Code only: a comment that says what went, and why, is allowed to name it.
const code = (rel) => read(rel)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

function sources(dir, out = []) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'build') sources(rel, out);
    } else if (/\.(js|jsx|mjs|cjs)$/.test(entry.name)) out.push(rel);
  }
  return out;
}
const APP = ['bot', 'services', 'server', 'database', 'lib', 'config', 'admin/src']
  .flatMap((dir) => sources(dir))
  .concat(['index.js']);

test('the Datatruck peer reactions are gone, with their settings and AI capability', () => {
  for (const rel of [
    'bot/datatruckPeerHandlers.js', 'services/datatruckPeerBotService.js',
    'services/datatruckPeerPatterns.js', 'services/datatruckBanterMessage.js',
  ]) assert.equal(exists(rel), false, `${rel} must not come back`);

  const named = APP.filter((rel) => /datatruckPeer|DATATRUCK_PEER|datatruckBanter|DATATRUCK_BANTER|DATATRUCK_LOAD_FLAME/.test(code(rel)));
  assert.deepEqual(named, []);
  assert.doesNotMatch(read('.env.example'), /DATATRUCK_PEER|DATATRUCK_BANTER|DATATRUCK_LOAD_FLAME/);

  const { CAPABILITIES } = require('../lib/ai/capabilityCatalog');
  assert.equal(CAPABILITIES.some((c) => c.key === 'datatruck_banter'), false);
});

test('the Indeed intake is gone, and pdf-parse with it', () => {
  assert.equal(exists('services/indeedLeadService.js'), false);
  assert.equal(exists('docs/gmail-indeed-apps-script.gs'), false);
  const named = APP.filter((rel) => /indeedLeadService|ingestIndeedLead|\/api\/internal\/indeed/.test(code(rel)));
  assert.deepEqual(named, []);
  assert.doesNotMatch(read('admin/src/pages/LeadsPage.jsx'), /APPS_SCRIPT|pollIndeed|script\.google\.com/);

  const pkg = JSON.parse(read('package.json'));
  assert.equal((pkg.dependencies || {})['pdf-parse'], undefined);
  assert.equal(JSON.parse(read('package-lock.json')).packages['node_modules/pdf-parse'], undefined);
  assert.deepEqual(APP.filter((rel) => /require\(['"]pdf-parse['"]\)/.test(code(rel))), []);
});

test('the Indeed leads already recorded are still shown and can still be found', () => {
  // The control: the intake went, the data and its display did not.
  const page = read('admin/src/pages/LeadsPage.jsx');
  assert.match(page, /key: "indeed", label: "Indeed"/);
  assert.match(page, /indeed: \{ label: "Indeed"/);
  assert.match(read('server/routes/leadsRoutes.js'), /req\.query\.source === 'indeed'/);
});

test('only /api/health answers health; the cron alias is gone', () => {
  const routes = read('server/routes/healthRoutes.js');
  assert.doesNotMatch(routes, /router\.(get|head)\('\/health'/);
  assert.match(routes, /router\.get\('\/api\/health'/);
  // What still depends on it: the container's own HEALTHCHECK.
  assert.match(read('Dockerfile'), /HEALTHCHECK[\s\S]*\/api\/health/);
});
