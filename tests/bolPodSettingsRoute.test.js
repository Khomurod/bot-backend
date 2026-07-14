/**
 * HTTP-layer tests for the /api/settings/bol-pod routes: admin-auth gating,
 * settings GET/PUT validation, central-group validate + test message, delivery
 * history shape (no private file links exposed), and manual retry. The db module
 * and the DataTruck client/service are stubbed via require.cache.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET ||= 'test-secret';
process.env.BOT_TOKEN ||= '000:testbot';
process.env.TELEGRAM_BOT_TOKEN ||= '000:testnotif';
process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.DATABASE_URL ||= 'postgresql://localhost:5432/unused_in_this_test';

const ROOT = path.resolve(__dirname, '..');
const R = (rel) => path.resolve(ROOT, rel);
function stub(rel, exports) {
  const filename = require.resolve(R(rel));
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

// Mutable stub state.
let settingsRow = {
  id: 1, enabled: false, delivery_mode: 'driver_group', central_group_id: null,
  central_group_title: null, central_group_validated_at: null,
  document_type_mode: 'both', uncertain_document_policy: 'do_not_send',
  last_tested_at: null, updated_by: null, updated_at: '2026-07-14T00:00:00Z',
};
let deliveriesRows = [];
let retryReturn = [];

stub('database/db.js', {
  query: async (text) => {
    if (/UPDATE bol_pod_forwarding_settings/.test(text)) return { rows: [] };
    if (/bol_pod_forwarding_settings/.test(text)) return { rows: [settingsRow] };
    if (/UPDATE datatruck_document_deliveries/.test(text)) return { rows: retryReturn };
    if (/ORDER BY updated_at DESC LIMIT 1/.test(text)) return { rows: [] };
    if (/FILTER \(WHERE/.test(text)) {
      return { rows: [{ last_success_at: null, last_failure_at: null, pending_retries: 0, total_sent: 0, total_failed: 0 }] };
    }
    if (/FROM datatruck_document_deliveries/.test(text)) return { rows: deliveriesRows };
    return { rows: [] };
  },
});
stub('services/datatruckApiService.js', { isConfigured: () => true });
stub('services/datatruckDocumentService.js', { getLastRunSummary: () => null });

const { createSettingsRouter } = require(R('server/routes/settingsRoutes'));

const telegramStub = {
  getMe: async () => ({ id: 42 }),
  getChat: async () => ({ type: 'supergroup', title: 'Ops Docs' }),
  getChatMember: async () => ({ status: 'administrator' }),
  sendMessage: async () => ({ message_id: 7 }),
};

function makeServer({ auth = 'ok' } = {}) {
  const app = express();
  app.use(express.json());
  const authMiddleware = auth === 'ok'
    ? (req, res, next) => { req.admin = { username: 'tester' }; next(); }
    : (req, res) => res.status(401).json({ error: 'Unauthorized' });
  app.use('/api/settings', createSettingsRouter({ authMiddleware, telegram: telegramStub }));
  return http.createServer(app);
}

async function withServer(opts, fn) {
  const server = makeServer(opts);
  await new Promise((r) => server.listen(0, r));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/settings`;
    await fn(base);
  } finally {
    server.close();
  }
}
const J = { 'Content-Type': 'application/json' };

test('GET /bol-pod returns settings with safe defaults', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/bol-pod`);
    assert.equal(res.status, 200);
    const { settings } = await res.json();
    assert.equal(settings.enabled, false);
    assert.equal(settings.deliveryMode, 'driver_group');
  });
});

test('all /bol-pod routes require admin auth (401 without it)', async () => {
  await withServer({ auth: 'deny' }, async (base) => {
    const get = await fetch(`${base}/bol-pod`);
    assert.equal(get.status, 401);
    const put = await fetch(`${base}/bol-pod`, { method: 'PUT', headers: J, body: '{}' });
    assert.equal(put.status, 401);
    const del = await fetch(`${base}/bol-pod/deliveries`);
    assert.equal(del.status, 401);
  });
});

test('PUT /bol-pod rejects an invalid delivery mode with 400', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/bol-pod`, { method: 'PUT', headers: J, body: JSON.stringify({ deliveryMode: 'bogus' }) });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /Invalid delivery mode/);
  });
});

test('PUT /bol-pod refuses to enable central mode without a validated group (400)', async () => {
  settingsRow = { ...settingsRow, delivery_mode: 'central_group', central_group_id: null, central_group_validated_at: null };
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/bol-pod`, { method: 'PUT', headers: J, body: JSON.stringify({ enabled: true, deliveryMode: 'central_group' }) });
    assert.equal(res.status, 400);
  });
  settingsRow = { ...settingsRow, delivery_mode: 'driver_group' };
});

test('PUT /bol-pod accepts a valid driver-only update (200)', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/bol-pod`, { method: 'PUT', headers: J, body: JSON.stringify({ enabled: true, deliveryMode: 'driver_group', documentTypeMode: 'bol' }) });
    assert.equal(res.status, 200);
    const { settings } = await res.json();
    assert.ok(settings);
  });
});

test('POST /bol-pod/validate-group validates via Telegram and returns ok', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/bol-pod/validate-group`, { method: 'POST', headers: J, body: JSON.stringify({ groupId: '-1002997837889' }) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.title, 'Ops Docs');
  });
});

test('POST /bol-pod/test-message sends a test message', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/bol-pod/test-message`, { method: 'POST', headers: J, body: JSON.stringify({ groupId: '-1002997837889' }) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  });
});

test('GET /bol-pod/status returns a status panel without secrets', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/bol-pod/status`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body.enabled, 'boolean');
    assert.equal(body.sourceConfigured, true);
    assert.equal('pendingRetries' in body, true);
  });
});

test('GET /bol-pod/deliveries exposes per-destination status but never the file link', async () => {
  deliveriesRows = [{
    id: 5, signature: 'dt-doc|1|bol|x|0', order_id: 'ORD1', load_reference: 'DT-1001',
    file_type: 'bill_of_lading', doc_classification: 'bol', file_link: 'https://secret/presigned.pdf',
    driver_name: 'John Smith', unit_number: '102', uploaded_at: '2026-07-14T10:00:00Z',
    created_at: '2026-07-14T10:05:00Z', updated_at: '2026-07-14T10:06:00Z',
    status: 'sent', telegram_group_id: -100111, telegram_message_id: 900, attempt_count: 1, last_error: null,
    central_status: 'failed', central_telegram_group_id: -100999, central_telegram_message_id: null, central_attempt_count: 2, central_last_error: 'Forbidden',
  }];
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/bol-pod/deliveries?limit=10`);
    assert.equal(res.status, 200);
    const { deliveries } = await res.json();
    assert.equal(deliveries.length, 1);
    const d = deliveries[0];
    assert.equal(d.docType, 'bol');
    assert.equal(d.driver.status, 'sent');
    assert.equal(d.central.status, 'failed');
    assert.equal(d.rollupStatus, 'partially_sent');
    assert.ok(!('fileLink' in d) && !('file_link' in d), 'must not expose the private file link');
    assert.ok(!JSON.stringify(d).includes('secret/presigned'), 'presigned URL must not leak');
  });
  deliveriesRows = [];
});

test('POST /bol-pod/deliveries/:id/retry returns the updated row, or 404 when nothing failed', async () => {
  retryReturn = [{
    id: 5, signature: 's', file_type: 'bill_of_lading', status: 'pending', central_status: 'pending',
    attempt_count: 0, central_attempt_count: 0, created_at: 'x', updated_at: 'y',
  }];
  await withServer({}, async (base) => {
    const ok = await fetch(`${base}/bol-pod/deliveries/5/retry`, { method: 'POST', headers: J, body: '{}' });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.delivery.id, 5);
  });
  retryReturn = [];
  await withServer({}, async (base) => {
    const notFound = await fetch(`${base}/bol-pod/deliveries/5/retry`, { method: 'POST', headers: J, body: '{}' });
    assert.equal(notFound.status, 404);
  });
});
