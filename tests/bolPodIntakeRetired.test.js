/**
 * The old BOL/POD *intake + upload* pipeline (drivers post documents in their
 * Telegram group -> AI classify -> match a load -> confirm -> UPLOAD to
 * DataTruck) was removed and is deliberately NOT restored: its DataTruck upload
 * endpoint was never verified, so it never ran live. This test pins that the
 * fragile intake/upload feature stays gone even though a *new, forwarding-only*
 * BOL/POD feature (DataTruck -> Telegram) has since been added.
 *
 * What is asserted GONE: the intake/upload/monitor modules, the dtdoc:
 * confirmation callbacks, any DataTruck document-upload call, and the old
 * /bol-pod-monitor routes.
 * What is asserted PRESENT: the new forwarding service wiring and the new
 * /bol-pod settings routes.
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

// The intake/upload/monitor modules must stay deleted.
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

test('the retired intake/upload/monitor modules stay deleted', () => {
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

test('the DataTruck client exposes no document-upload endpoint (forwarding only)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'services/datatruckApiService.js'), 'utf8');
  assert.ok(!/uploadOrderDocument/.test(src), 'datatruckApiService must not upload documents');
});

test('index.js wires the forwarding service and never the retired intake', () => {
  const indexSrc = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  assert.match(indexSrc, /startDatatruckDocumentService/, 'forwarding service must stay wired');
  assert.ok(!/documentIntake/i.test(indexSrc), 'index.js must not reference the retired intake');
});

test('settings API: /bol-pod-monitor is gone (404); /bol-pod (new forwarding) resolves', async () => {
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
    // The new forwarding settings route exists.
    const alive = await fetch(`${base}/bol-pod`);
    assert.notEqual(alive.status, 404, 'new /bol-pod settings route must exist');
  } finally {
    server.close();
  }
});
