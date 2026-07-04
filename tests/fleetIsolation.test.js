/**
 * FleetView isolation invariants (static analysis, no server needed).
 *
 * 1. The main app depends on FleetView ONLY via the single guarded mount in
 *    server/api.js — deleting server/fleet/ must not break anything else.
 * 2. FleetView never imports outbound-capable modules (Bitrix, RingCentral,
 *    Telegram bot, OTP mailer, Facebook Graph) or any scheduler — external
 *    integrations stay read-only.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function listJs(dir) {
  const out = [];
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...listJs(path.join(dir, entry.name)));
    else if (/\.(js|jsx)$/.test(entry.name)) out.push(path.join(dir, entry.name));
  }
  return out;
}
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('main app references FleetView only via the single guarded mount in server/api.js', () => {
  const mainDirs = ['services', 'bot', 'database', 'server/routes', 'server/services', 'config'];
  const offenders = [];
  for (const dir of mainDirs) {
    for (const file of listJs(dir)) {
      if (/require\((['"]).*fleet/.test(read(file))) offenders.push(file);
    }
  }
  assert.deepStrictEqual(offenders, [], `main-app files must not import FleetView: ${offenders.join(', ')}`);

  const indexJs = read('index.js');
  assert.ok(!/require\((['"]).*fleet/.test(indexJs), 'index.js must not import FleetView');

  const apiJs = read('server/api.js');
  const mounts = apiJs.match(/require\(['"]\.\/fleet['"]\)/g) || [];
  assert.strictEqual(mounts.length, 1, 'exactly one fleet mount in server/api.js');
  assert.match(apiJs, /try\s*\{\s*require\(['"]\.\/fleet['"]\)\.mountFleet\(app\);/, 'fleet mount must be wrapped so failure cannot crash the main app');
});

test('FleetView backend never imports outbound-capable or scheduler modules', () => {
  const forbidden = [
    'bitrix24', 'ringCentral', 'otpService', 'facebookGraph', 'facebookWebhook',
    'facebookConnect', 'facebookLead', 'indeedLead', 'schedulerService',
    'birthdayService', 'mileageBonus', 'raiseApproval', 'fuelStopAlert',
    'dispatchEtaUpdate', 'roadBonus', 'recruiterCallSync', 'datatruckDocumentService',
    'bot/bot', 'leadsTelegramClient', 'telegramBotTokens', 'broadcastTarget',
  ];
  const violations = [];
  for (const file of listJs('server/fleet')) {
    const src = read(file);
    const requires = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
    for (const dep of requires) {
      for (const bad of forbidden) {
        if (dep.includes(bad)) violations.push(`${file} → ${dep}`);
      }
    }
  }
  assert.deepStrictEqual(violations, [], `FleetView imports outbound/scheduler modules: ${violations.join(', ')}`);
});

test('FleetView backend performs no outbound sends (no sendMessage/sendSms/sendMail calls)', () => {
  const badCalls = /\b(sendMessage|sendSms|sendMail|sendDocument|sendPhoto|createCrmRecordFromLead)\s*\(/;
  const violations = [];
  for (const file of listJs('server/fleet')) {
    if (badCalls.test(read(file))) violations.push(file);
  }
  assert.deepStrictEqual(violations, [], `FleetView contains outbound send calls: ${violations.join(', ')}`);
});

test('production code contains no demo credentials outside the demo store/tests', () => {
  // demo1234 may exist only in the demo seed store, the demo-gated login page,
  // and test files — never in real-mode modules.
  const realModeFiles = ['server/fleet/realProvider.js', 'server/fleet/realDb.js', 'server/fleet/realTasks.js', 'server/fleet/config.js'];
  for (const f of realModeFiles) {
    const src = read(f);
    assert.ok(!src.includes('demo1234'), `${f} must not contain demo credentials`);
    assert.ok(!src.includes('example.com'), `${f} must not contain demo domains`);
  }
});
