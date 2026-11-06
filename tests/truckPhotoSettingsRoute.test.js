'use strict';

/**
 * Settings → Truck Photos, the HTTP layer, with the real settings store over a
 * stubbed pool. The rules worth pinning: off by default; the recipient is a
 * person's numeric id; it cannot be switched on until a test message reached
 * that person; a person who never pressed Start is told so in words (200, not
 * an error); changing the recipient switches it off; errors carry `error`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://localhost:5432/unused_in_this_test';

const ROOT = path.resolve(__dirname, '..');
function stub(rel, exports) {
  const filename = require.resolve(path.resolve(ROOT, rel));
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

let row;
stub('database/pool.js', {
  pool: {},
  query: async (text, values) => {
    if (/^\s*SELECT \* FROM truck_photo_settings/.test(text)) return { rows: [row] };
    if (/INSERT INTO truck_photo_settings/.test(text)) {
      const [enabled, recipient, verifiedAt, lookback, adminId] = values;
      if (enabled && !(recipient && verifiedAt)) throw Object.assign(new Error('check constraint'), { code: '23514' });
      row = {
        ...row, enabled, recipient_telegram_id: recipient, recipient_verified_at: verifiedAt,
        lookback_hours: lookback, updated_by: adminId,
      };
      return { rows: [row] };
    }
    if (/UPDATE truck_photo_settings\s+SET recipient_verified_at/.test(text)) {
      if (String(row.recipient_telegram_id) !== String(values[0])) return { rows: [] };
      row = { ...row, recipient_verified_at: new Date('2026-11-06T15:00:00Z') };
      return { rows: [row] };
    }
    return { rows: [] };
  },
});
stub('database/truckPhotos/reports.js', { listRecentReports: async () => [] });

const { createTruckPhotoSettingsRouter } = require('../server/routes/settings/truckPhotoRoutes');
const settingsStore = require('../database/truckPhotos/settings');

let refusal = null;
const sent = [];
const telegram = {
  getMe: async () => ({ id: 1, username: 'WenzeBot' }),
  sendMessage: async (...args) => {
    if (refusal) throw refusal;
    sent.push(args);
    return { message_id: 1 };
  },
};

async function withServer(fn) {
  settingsStore.invalidateCache();
  const app = express();
  app.use(express.json());
  app.use('/s', createTruckPhotoSettingsRouter({
    authMiddleware: (req, res, next) => { req.admin = { id: 5 }; next(); }, telegram,
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}/s`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  try { await fn(call); } finally { server.close(); }
}

function reset() {
  row = { id: 1, enabled: false, recipient_telegram_id: null, recipient_verified_at: null, lookback_hours: 3, max_photos_per_pdf: 60 };
  refusal = null;
  sent.length = 0;
}

test('off by default; it cannot be switched on without a recipient the bot reached', async () => {
  reset();
  await withServer(async (call) => {
    const got = await call('GET', '/truck-photos');
    assert.equal(got.status, 200);
    assert.deepEqual(
      { enabled: got.body.settings.enabled, recipient: got.body.settings.recipientTelegramId, lookback: got.body.settings.lookbackHours },
      { enabled: false, recipient: null, lookback: 3 },
    );
    assert.deepEqual(got.body.recent, []);

    const on = await call('PUT', '/truck-photos', { enabled: true });
    assert.equal(on.status, 400);
    assert.match(on.body.error, /Before switching Truck Photos on/);

    const saved = await call('PUT', '/truck-photos', { recipientTelegramId: '1234567' });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.recipientTelegramId, '1234567');
    const stillOff = await call('PUT', '/truck-photos', { enabled: true });
    assert.equal(stillOff.status, 400, 'saved but not reached is not enough');
  });
});

test('a person who never pressed Start: a 200 verdict that says so in words, and the switch stays locked', async () => {
  reset();
  row.recipient_telegram_id = '1234567';
  refusal = Object.assign(new Error('403: Forbidden'), {
    response: { error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" },
  });
  await withServer(async (call) => {
    const out = await call('POST', '/truck-photos/test-message');
    assert.equal(out.status, 200);
    assert.equal(out.body.ok, false);
    assert.equal(out.body.reason, 'not_started');
    assert.match(out.body.message, /has not pressed Start on the bot yet.*@WenzeBot/);
    assert.equal((await call('PUT', '/truck-photos', { enabled: true })).status, 400);
  });
});

test('the test message arrives: recorded, and then it can be switched on', async () => {
  reset();
  row.recipient_telegram_id = '1234567';
  await withServer(async (call) => {
    const out = await call('POST', '/truck-photos/test-message');
    assert.equal(out.body.ok, true);
    assert.ok(out.body.settings.recipientVerifiedAt);
    assert.equal(sent[0][0], '1234567', 'to the person, privately');
    const on = await call('PUT', '/truck-photos', { enabled: true });
    assert.equal(on.status, 200);
    assert.equal(on.body.enabled, true);

    const moved = await call('PUT', '/truck-photos', { recipientTelegramId: '7654321' });
    assert.equal(moved.body.enabled, false, 'a new person has not been reached yet');
    assert.equal(moved.body.recipientVerifiedAt, null);
  });
});

test('the recipient is a person\'s id, digits only; the look-back is 1 to 24 hours', async () => {
  reset();
  await withServer(async (call) => {
    for (const bad of ['-1001234567890', '@kim', '12ab', '0']) {
      // eslint-disable-next-line no-await-in-loop
      const out = await call('PUT', '/truck-photos', { recipientTelegramId: bad });
      assert.equal(out.status, 400, bad);
      assert.match(out.body.error, /digits only/);
    }
    for (const bad of [0, 25, 2.5, 'three']) {
      // eslint-disable-next-line no-await-in-loop
      const out = await call('PUT', '/truck-photos', { lookbackHours: bad });
      assert.equal(out.status, 400, String(bad));
      assert.match(out.body.error, /1 to 24/);
    }
    const ok = await call('PUT', '/truck-photos', { lookbackHours: 6 });
    assert.equal(ok.body.lookbackHours, 6);
  });
});

test('a test with no recipient saved is an error with `error`; other refusals are explained', async () => {
  reset();
  await withServer(async (call) => {
    const none = await call('POST', '/truck-photos/test-message');
    assert.equal(none.status, 400);
    assert.equal(none.body.error, 'Save the recipient first.');
  });
  reset();
  row.recipient_telegram_id = '1234567';
  refusal = Object.assign(new Error('400'), { response: { error_code: 400, description: 'Bad Request: chat not found' } });
  await withServer(async (call) => {
    const out = await call('POST', '/truck-photos/test-message');
    assert.equal(out.body.reason, 'unknown_user');
    assert.match(out.body.message, /not a group's/);
  });
  refusal = Object.assign(new Error('403'), { response: { error_code: 403, description: 'Forbidden: bot was blocked by the user bot123:SECRET' } });
  await withServer(async (call) => {
    const out = await call('POST', '/truck-photos/test-message');
    assert.equal(out.body.reason, 'blocked');
    assert.doesNotMatch(JSON.stringify(out.body), /SECRET/);
  });
});
