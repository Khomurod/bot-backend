/**
 * The DAT UI inspector stays removed (October 2026, hidden-functions audit).
 *
 * `POST /api/dat-ui/inspect` took a snapshot of a DAT load-board page from a
 * Chrome extension that is not in this repository and that the company does
 * not use, and sent it to Groq for layout advice. It answered loopback callers
 * only and nothing here called it: a model call and a data path with no user.
 * The route is proven 404 in tests/api-surface.test.js; this holds the module,
 * the AI capability and the documents.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('the inspector module is gone and nothing names it', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'services/datUiInspectorService.js')), false);
  for (const rel of ['server/routes/healthRoutes.js', 'services/groqClient.js']) {
    assert.ok(!read(rel).includes('datUiInspector'), `${rel} must not name the inspector`);
    assert.ok(!read(rel).includes('/api/dat-ui/'), `${rel} must not mount the route`);
  }
});

test('Settings → AI no longer lists it as a responsibility', () => {
  const { CAPABILITIES } = require('../lib/ai/capabilityCatalog');
  assert.equal(CAPABILITIES.some((c) => c.key === 'dat_ui_inspection'), false);
});

test('the permissions table no longer lists the route', () => {
  assert.ok(!read('docs/brief/permissions.md').includes('/api/dat-ui/inspect'));
});
