/**
 * Tests for services/bolPodTestMonitorService.js — the silent reporter.
 * Uses a fake telegram + injected merge/settingsDb/Input so nothing hits the
 * network or DB. Proves: toggles honored, files sent (single/merged/fallback),
 * report goes to the TEST group, failures don't throw, and — critically — no
 * Datatruck upload function is ever called.
 */
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.JWT_SECRET ||= 'test';
process.env.BOT_TOKEN ||= 'test';
process.env.TELEGRAM_BOT_TOKEN ||= 'test';
process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY ||= 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const monitor = require('../services/bolPodTestMonitorService');

function fakeTelegram() {
  const calls = { messages: [], documents: [] };
  return {
    calls,
    async sendMessage(chatId, text, extra) { calls.messages.push({ chatId, text, extra }); return { message_id: calls.messages.length }; },
    async sendDocument(chatId, input, extra) { calls.documents.push({ chatId, input, extra }); return { message_id: 1 }; },
  };
}

const deps = {
  settingsDb: { recordReportSent: async () => {} },
  Input: { fromBuffer: (buffer, name) => ({ __buffer: buffer, name }) },
};

function settings(over = {}) {
  return { enabled: true, testGroupId: '-5289094495', sendUnrelated: true, sendUnclear: true, sendFiles: false, ...over };
}

function result(type, over = {}) {
  return {
    action: type === 'unrelated' ? 'ignored' : 'confirm',
    docType: type,
    classification: { type, confidence: 0.8, summary: `${type} evidence` },
    match: { confidence: 'high', orderId: '123', loadReference: 'L1', reasons: ['load matched'] },
    batch: { telegram_chat_id: -100777, sender_username: 'driverx', telegram_user_id: 55 },
    ...over,
  };
}

test('disabled monitor sends nothing', async () => {
  const tg = fakeTelegram();
  const r = await monitor.reportDetection({ telegram: tg, result: result('pod'), settings: settings({ enabled: false }) }, deps);
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'monitor_disabled');
  assert.equal(tg.calls.messages.length, 0);
});

test('no test group configured → nothing sent', async () => {
  const tg = fakeTelegram();
  const r = await monitor.reportDetection({ telegram: tg, result: result('bol'), settings: settings({ testGroupId: null }) }, deps);
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'no_test_group');
  assert.equal(tg.calls.messages.length, 0);
});

test('BOL report is sent to the test group', async () => {
  const tg = fakeTelegram();
  const r = await monitor.reportDetection({ telegram: tg, result: result('bol'), settings: settings() }, deps);
  assert.equal(r.sent, true);
  assert.equal(tg.calls.messages.length, 1);
  assert.equal(tg.calls.messages[0].chatId, '-5289094495');
  assert.match(tg.calls.messages[0].text, /BOL\/POD Test Detection/);
  assert.match(tg.calls.messages[0].text, /Detected type:<\/b> BOL/);
  assert.match(tg.calls.messages[0].text, /No upload happened/);
});

test('POD report is sent to the test group', async () => {
  const tg = fakeTelegram();
  const r = await monitor.reportDetection({ telegram: tg, result: result('pod'), settings: settings() }, deps);
  assert.equal(r.sent, true);
  assert.match(tg.calls.messages[0].text, /Detected type:<\/b> POD/);
});

// ── STRICT policy: only confirmed BOL/POD reach the Automatic Update group ──

test('unrelated is suppressed regardless of legacy sendUnrelated toggle', async () => {
  for (const sendUnrelated of [false, true]) {
    const tg = fakeTelegram();
    const r = await monitor.reportDetection({ telegram: tg, result: result('unrelated'), settings: settings({ sendUnrelated }) }, deps);
    assert.equal(r.sent, false, `unrelated must never be sent (sendUnrelated=${sendUnrelated})`);
    assert.equal(r.reason, 'not_confirmed_bol_pod');
    assert.equal(tg.calls.messages.length, 0);
  }
});

test('unclear is suppressed regardless of legacy sendUnclear toggle', async () => {
  for (const sendUnclear of [false, true]) {
    const tg = fakeTelegram();
    const r = await monitor.reportDetection({ telegram: tg, result: result('unclear'), settings: settings({ sendUnclear }) }, deps);
    assert.equal(r.sent, false, `unclear must never be sent (sendUnclear=${sendUnclear})`);
    assert.equal(r.reason, 'not_confirmed_bol_pod');
    assert.equal(tg.calls.messages.length, 0);
  }
});

test('both (BOL+POD) is suppressed under strict policy', async () => {
  const tg = fakeTelegram();
  const r = await monitor.reportDetection({ telegram: tg, result: result('both'), settings: settings() }, deps);
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'not_confirmed_bol_pod');
  assert.equal(tg.calls.messages.length, 0);
});

test('mismatch-only / no-load BOL is still sent when docType is a confirmed BOL', async () => {
  // Strict policy keys off the AI docType (bol/pod), NOT the load-match outcome.
  const tg = fakeTelegram();
  const r = await monitor.reportDetection({
    telegram: tg,
    result: result('bol', { match: { confidence: 'mismatch', orderId: null, loadReference: null, reasons: ['no load matched'] } }),
    settings: settings(),
  }, deps);
  assert.equal(r.sent, true);
  assert.match(tg.calls.messages[0].text, /Detected type:<\/b> BOL/);
});

test('unclear from unconfigured Gemini is NOT sent', async () => {
  const tg = fakeTelegram();
  const r = await monitor.reportDetection({
    telegram: tg,
    result: result('unclear', { classification: { type: 'unclear', confidence: 0, summary: 'AI classifier not configured', configured: false } }),
    settings: settings(),
  }, deps);
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'not_confirmed_bol_pod');
  assert.equal(tg.calls.messages.length, 0);
});

test('sendFiles=false → no document sent, only report text', async () => {
  const tg = fakeTelegram();
  let loaded = false;
  await monitor.reportDetection({
    telegram: tg, result: result('pod'), settings: settings({ sendFiles: false }),
    loadFiles: async () => { loaded = true; return [{ buffer: Buffer.from('x'), fileName: 'a.pdf' }]; },
  }, deps);
  assert.equal(loaded, false, 'files are not even loaded when sendFiles is off');
  assert.equal(tg.calls.documents.length, 0);
  assert.equal(tg.calls.messages.length, 1);
});

test('single file is sent as-is when sendFiles=true', async () => {
  const tg = fakeTelegram();
  const merge = { prepareUpload: async (files) => ({ buffer: files[0].buffer, filename: 'BOL_test.pdf', mimeType: 'application/pdf', merged: false }) };
  const r = await monitor.reportDetection({
    telegram: tg, result: result('bol'), settings: settings({ sendFiles: true }),
    loadFiles: async () => [{ buffer: Buffer.from('PDF1'), fileName: 'a.pdf', mimeType: 'application/pdf' }],
  }, { ...deps, merge });
  assert.equal(r.sent, true);
  assert.equal(tg.calls.documents.length, 1);
  assert.match(tg.calls.messages[0].text, /Files:<\/b> 1/);
});

test('multiple files are merged into one PDF', async () => {
  const tg = fakeTelegram();
  const merge = { prepareUpload: async () => ({ buffer: Buffer.from('MERGED'), filename: 'POD_test.pdf', mimeType: 'application/pdf', merged: true }) };
  const r = await monitor.reportDetection({
    telegram: tg, result: result('pod'), settings: settings({ sendFiles: true }),
    loadFiles: async () => [
      { buffer: Buffer.from('A'), fileName: 'a.jpg', mimeType: 'image/jpeg' },
      { buffer: Buffer.from('B'), fileName: 'b.jpg', mimeType: 'image/jpeg' },
    ],
  }, { ...deps, merge });
  assert.equal(r.sent, true);
  assert.equal(tg.calls.documents.length, 1);
  assert.match(tg.calls.messages[0].text, /merged into one PDF/);
});

test('merge failure → falls back to sending originals separately + warning', async () => {
  const tg = fakeTelegram();
  const merge = { prepareUpload: async () => { throw new Error('unsupported HEIC'); } };
  const r = await monitor.reportDetection({
    telegram: tg, result: result('pod'), settings: settings({ sendFiles: true }),
    loadFiles: async () => [
      { buffer: Buffer.from('A'), fileName: 'a.heic', mimeType: 'image/heic' },
      { buffer: Buffer.from('B'), fileName: 'b.heic', mimeType: 'image/heic' },
    ],
  }, { ...deps, merge });
  assert.equal(r.sent, true);
  assert.equal(tg.calls.documents.length, 2, 'both originals sent separately');
  assert.match(tg.calls.messages[0].text, /merge failed/i);
});

test('too-large merged file → report sent with a warning, no document', async () => {
  const tg = fakeTelegram();
  const big = Buffer.alloc(monitor.MAX_SEND_BYTES + 10);
  const merge = { prepareUpload: async () => ({ buffer: big, filename: 'x.pdf', mimeType: 'application/pdf', merged: true }) };
  const r = await monitor.reportDetection({
    telegram: tg, result: result('pod'), settings: settings({ sendFiles: true }),
    loadFiles: async () => [{ buffer: big, fileName: 'x.pdf', mimeType: 'application/pdf' }],
  }, { ...deps, merge });
  assert.equal(r.sent, true);
  assert.equal(tg.calls.documents.length, 0);
  assert.match(tg.calls.messages[0].text, /too large/i);
});

test('a test-group send failure is swallowed (never throws), returns error', async () => {
  const tg = {
    async sendMessage() { throw new Error('chat not found'); },
    async sendDocument() {},
  };
  const r = await monitor.reportDetection({ telegram: tg, result: result('bol'), settings: settings() }, deps);
  assert.equal(r.sent, false);
  assert.ok(r.error);
});

test('NO Datatruck upload function is ever called by the monitor', async () => {
  const apiSvc = require('../services/datatruckApiService');
  const uploadSvc = require('../services/datatruckUploadService');
  let uploadCalls = 0;
  const origApi = apiSvc.uploadOrderDocument;
  const origUp = uploadSvc.uploadConfirmedBatch;
  apiSvc.uploadOrderDocument = async () => { uploadCalls += 1; return {}; };
  uploadSvc.uploadConfirmedBatch = async () => { uploadCalls += 1; return {}; };
  try {
    const tg = fakeTelegram();
    const merge = { prepareUpload: async () => ({ buffer: Buffer.from('M'), filename: 'BOL.pdf', mimeType: 'application/pdf', merged: true }) };
    await monitor.reportDetection({
      telegram: tg, result: result('bol'), settings: settings({ sendFiles: true }),
      loadFiles: async () => [{ buffer: Buffer.from('A'), fileName: 'a.pdf' }, { buffer: Buffer.from('B'), fileName: 'b.pdf' }],
    }, { ...deps, merge });
    assert.equal(uploadCalls, 0, 'the silent monitor must never upload to Datatruck');
  } finally {
    apiSvc.uploadOrderDocument = origApi;
    uploadSvc.uploadConfirmedBatch = origUp;
  }
});
