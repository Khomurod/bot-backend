'use strict';

/**
 * Admin → Users → Company Employees routes. The store and the card renderer
 * are stand-ins; made-up names throughout.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createCompanyEmployeesRouter, readProfile } = require('../server/routes/companyEmployeesRoutes');

function fakeStore(rows, accounts = []) {
  const saw = { updates: [], suggestions: null, photos: new Map(), confirmed: [] };
  const store = {
    async listCompanyEmployees() { return rows.map((r) => ({ ...r, has_photo: saw.photos.has(r.id) })); },
    async getCompanyEmployee(id) {
      const row = rows.find((r) => r.id === id);
      return row ? { ...row, has_photo: saw.photos.has(id) } : null;
    },
    async updateCompanyEmployee(id, values) {
      saw.updates.push({ id, values });
      return rows.some((r) => r.id === id) ? { id, ...values } : null;
    },
    async confirmTelegramMatch(id) {
      const row = rows.find((r) => r.id === id && r.telegram_match === 'suggested');
      if (row) saw.confirmed.push(id);
      return row ? { ...row, telegram_match: 'confirmed' } : null;
    },
    async listKnownTelegramAccounts() { return accounts; },
    async applyTelegramSuggestions(list) { saw.suggestions = list; return list.length; },
    async savePhoto(id, image) { saw.photos.set(id, image); },
    async getPhoto(id) { return saw.photos.get(id) || null; },
    async deletePhoto(id) { return saw.photos.delete(id); },
  };
  return { store, saw };
}

const card = {
  async normalisePhoto(buffer) {
    if (!buffer.toString().startsWith('IMG')) throw new Error('not an image');
    return Buffer.from(`square:${buffer.toString()}`);
  },
  async renderBirthdayCard(employee, photo) { return Buffer.from(`card:${employee.id}:${photo ? photo.toString() : 'none'}`); },
};

function loadApp(rows, accounts) {
  const { store, saw } = fakeStore(rows, accounts);
  const app = express();
  app.use(express.json());
  app.use('/api/company-employees', createCompanyEmployeesRouter({
    authMiddleware: (req, _res, next) => { req.admin = { id: 1, username: 'tester' }; next(); },
    store,
    card,
    audit: async () => null,
  }));
  return { app, saw };
}

async function call(app, method, url, { json, form } = {}) {
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method,
      headers: json === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: form || (json === undefined ? undefined : JSON.stringify(json)),
    });
    const type = res.headers.get('content-type') || '';
    const body = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()).toString();
    return { status: res.status, type, body };
  } finally { server.close(); }
}

const ROWS = [
  { id: 1, first_name: 'TESTBEK', last_name: 'EXAMPLOV', american_name: 'Sample Person', telegram_match: null },
  { id: 2, first_name: 'OZOD', last_name: 'EXAMPLOV', american_name: 'Quinn', telegram_match: 'confirmed', telegram_user_id: '900' },
  { id: 3, first_name: 'ZEBO', last_name: 'EXAMPLOVA', american_name: 'Rory', telegram_match: 'suggested', telegram_user_id: '901' },
];

test('the profile is checked: username shape, digits-only id, a sane American name', () => {
  assert.deepEqual(readProfile({ americanName: '  Sample  Person ', telegramUsername: '@Sample_Person', telegramUserId: '12345' }).values,
    { americanName: 'Sample Person', telegramUsername: 'sample_person', telegramUserId: '12345' });
  assert.match(readProfile({ telegramUsername: 'ab' }).error, /5–32/);
  assert.match(readProfile({ telegramUserId: '12a' }).error, /digits/);
  assert.match(readProfile({ telegramUserId: '9'.repeat(19) }).error, /digits/);
  assert.match(readProfile({ americanName: 'x'.repeat(81) }).error, /too long/);
  assert.deepEqual(readProfile({}).values, { americanName: null, telegramUsername: null, telegramUserId: null });
});

test('saving a row stores what was typed; a bad value is refused before the store', async () => {
  const { app, saw } = loadApp(ROWS);
  const ok = await call(app, 'PUT', '/api/company-employees/1', { json: { americanName: 'Sample Person', telegramUsername: 'sample_person' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(saw.updates, [{ id: 1, values: { americanName: 'Sample Person', telegramUsername: 'sample_person', telegramUserId: null } }]);
  const bad = await call(app, 'PUT', '/api/company-employees/1', { json: { telegramUsername: 'a b' } });
  assert.equal(bad.status, 400);
  assert.equal((await call(app, 'PUT', '/api/company-employees/99', { json: {} })).status, 404);
  assert.equal(saw.updates.length, 2);
});

test('suggestions never touch a confirmed row, nor offer its account to someone else', async () => {
  const accounts = [
    { telegram_user_id: '900', first_name: 'Sample', last_name: 'Person' }, // confirmed as employee 2's
    { telegram_user_id: '777', first_name: 'Rory', last_name: '| Update', username: 'rory_up' },
    { telegram_user_id: '778', first_name: 'Quinn' },
  ];
  const { app, saw } = loadApp(ROWS, accounts);
  const res = await call(app, 'POST', '/api/company-employees/suggest-telegram', { json: {} });
  assert.equal(res.status, 200);
  assert.deepEqual(saw.suggestions.map((s) => [s.employeeId, s.telegramUserId]), [[3, '777']]);
  assert.equal(res.body.suggested, 1);
});

test('only a suggested account can be confirmed', async () => {
  const { app, saw } = loadApp(ROWS);
  assert.equal((await call(app, 'POST', '/api/company-employees/3/confirm-telegram')).status, 200);
  assert.equal((await call(app, 'POST', '/api/company-employees/2/confirm-telegram')).status, 409);
  assert.deepEqual(saw.confirmed, [3]);
});

test('a photo is re-encoded before it is stored; a non-image is refused', async () => {
  const { app, saw } = loadApp(ROWS);
  const form = new FormData();
  form.append('photo', new Blob(['IMG-bytes'], { type: 'image/png' }), 'face.png');
  assert.equal((await call(app, 'PUT', '/api/company-employees/1/photo', { form })).status, 200);
  assert.equal(saw.photos.get(1).toString(), 'square:IMG-bytes');

  const junk = new FormData();
  junk.append('photo', new Blob(['nope'], { type: 'image/jpeg' }), 'x.jpg');
  const refused = await call(app, 'PUT', '/api/company-employees/1/photo', { form: junk });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /could not be read/);

  const pdf = new FormData();
  pdf.append('photo', new Blob(['IMG'], { type: 'application/pdf' }), 'x.pdf');
  assert.equal((await call(app, 'PUT', '/api/company-employees/1/photo', { form: pdf })).status, 400);
  assert.equal((await call(app, 'PUT', '/api/company-employees/99/photo', { form })).status, 404);
});

test('the card preview is drawn with the stored photo, and nothing is sent', async () => {
  const { app, saw } = loadApp(ROWS);
  saw.photos.set(1, Buffer.from('square:face'));
  const res = await call(app, 'GET', '/api/company-employees/1/card');
  assert.equal(res.status, 200);
  assert.equal(res.type, 'image/jpeg');
  assert.equal(res.body, 'card:1:square:face');
  assert.equal((await call(app, 'GET', '/api/company-employees/2/card')).body, 'card:2:none');
  assert.equal((await call(app, 'GET', '/api/company-employees/2/photo')).status, 404);
  assert.equal((await call(app, 'DELETE', '/api/company-employees/1/photo')).body.removed, true);
});
