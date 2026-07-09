/**
 * The BOL/POD monitoring feature (Telegram→Datatruck smart intake + silent
 * test monitor + admin Settings tab) was fully retired. This test pins the
 * removal so it cannot silently come back:
 *   - the BOL/POD-only modules are gone from disk,
 *   - the bot registers no document-intake / dtdoc: handlers,
 *   - the settings API no longer exposes /bol-pod-monitor routes,
 *   - the admin UI has no BOL/POD Monitor tab or API functions,
 *   - the leads bot stays enabled and the kept Datatruck delivery service
 *     stays wired in index.js.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

process.env.JWT_SECRET ||= 'test-secret';
process.env.BOT_TOKEN ||= '000:testbot';
process.env.TELEGRAM_BOT_TOKEN ||= '000:testnotif';
process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.DATABASE_URL ||= 'postgresql://localhost:5432/unused_in_this_test';

const ROOT = path.resolve(__dirname, '..');

const REMOVED_FILES = [
  'bot/documentIntakeHandlers.js',
  'services/documentIntakeService.js',
  'services/documentIntakeHelpers.js',
  'services/documentClassifierService.js',
  'services/documentLoadMatcher.js',
  'services/documentMergeService.js',
  'services/datatruckUploadService.js',
  'services/bolPodMonitorSettingsService.js',
  'services/bolPodTestMonitorService.js',
  'database/bolPodMonitorSettings.js',
  'database/telegramDocuments.js',
  'admin/src/pages/settings/BolPodMonitorTab.jsx',
];

test('BOL/POD-only modules are deleted', () => {
  for (const rel of REMOVED_FILES) {
    assert.equal(fs.existsSync(path.join(ROOT, rel)), false, `${rel} must not exist`);
  }
});

test('bot sources register no document intake and no dtdoc: callbacks', () => {
  const botDir = path.join(ROOT, 'bot');
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  })(botDir);

  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    assert.ok(!/documentIntake/i.test(src), `${path.relative(ROOT, file)} references documentIntake`);
    assert.ok(!/dtdoc/.test(src), `${path.relative(ROOT, file)} references dtdoc callbacks`);
  }
});

test('settings API has no /bol-pod-monitor routes (404), other settings still resolve', async () => {
  // Only the DB module needs faking: the settings router's other deps load
  // fine with dummy env and never run at registration time.
  const dbPath = path.resolve(__dirname, '../database/db.js');
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: { query: async () => ({ rows: [] }) },
  };

  const express = require('express');
  const { createSettingsRouter } = require('../server/routes/settingsRoutes');
  const app = express();
  app.use(express.json());
  app.use('/api/settings', createSettingsRouter({ authMiddleware: (req, res, next) => next() }));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/settings`;
    for (const [method, pathname] of [
      ['GET', '/bol-pod-monitor'],
      ['PUT', '/bol-pod-monitor'],
      ['GET', '/bol-pod-monitor/status'],
      ['POST', '/bol-pod-monitor/test-message'],
      ['POST', '/bol-pod-monitor/check-access'],
    ]) {
      const res = await fetch(`${base}${pathname}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method === 'GET' ? undefined : '{}',
      });
      assert.equal(res.status, 404, `${method} ${pathname} must be gone`);
    }

    // Sanity: the router itself still serves its remaining settings routes.
    const alive = await fetch(`${base}/message-groups`);
    assert.notEqual(alive.status, 404, 'message-groups settings route must survive');
  } finally {
    server.close();
  }
});

test('admin UI has no BOL/POD Monitor tab or API functions', () => {
  const settingsPage = fs.readFileSync(path.join(ROOT, 'admin/src/pages/SettingsPage.jsx'), 'utf8');
  assert.ok(!/bolpod|BolPod|BOL\/POD/i.test(settingsPage), 'SettingsPage must not mention BOL/POD');

  const api = fs.readFileSync(path.join(ROOT, 'admin/src/api.js'), 'utf8');
  assert.ok(!/bol-pod|BolPod/i.test(api), 'admin api.js must not expose BOL/POD functions');
});

test('leads bot stays enabled and the kept Datatruck delivery service stays wired', () => {
  const indexSrc = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  assert.match(indexSrc, /ENABLE_LEADS_BOT/, 'leads bot wiring must survive');
  assert.match(indexSrc, /startDatatruckDocumentService/, 'Datatruck document delivery must stay wired');
  assert.ok(!/documentIntake|bolPod/i.test(indexSrc), 'index.js must not reference the retired intake/monitor');
});
