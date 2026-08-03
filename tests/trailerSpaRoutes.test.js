/**
 * /trailers is the Trailer Department's public-facing slug, so the REAL Express
 * app must hand the admin SPA's index.html to a direct hit, a browser refresh,
 * and a deep link. Without the catch-all entry those URLs 404 — the classic
 * single-page-app deployment bug, and one that only shows up outside the SPA's
 * own in-app navigation.
 *
 * This boots server/api.js itself rather than a stand-in router: the point is
 * that the mounted route list is right, which a hand-built app cannot prove.
 */
'use strict';
process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-bot-token';
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.MANAGEMENT_GROUP_ID ||= '-1001234567890';
process.env.JWT_SECRET ||= 'test-jwt-secret';
process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('../server/api');

const BUILD_DIR = path.resolve(__dirname, '../admin/build');
const SPA_INDEX = path.join(BUILD_DIR, 'index.html');

let server;
let port;
/** Paths this test created because no admin build was present; removed after. */
let createdIndex = false;
let createdDir = false;

test.before(async () => {
  // The catch-all answers 503 when admin/build/index.html is absent, and that
  // directory is gitignored — CI installs with --ignore-scripts and never
  // builds it. Stand in for it so the ROUTING contract is tested the same way
  // everywhere. A real build is left completely untouched.
  if (!fs.existsSync(SPA_INDEX)) {
    if (!fs.existsSync(BUILD_DIR)) {
      fs.mkdirSync(BUILD_DIR, { recursive: true });
      createdDir = true;
    }
    fs.writeFileSync(SPA_INDEX, '<!DOCTYPE html><html><body><div id="root"></div></body></html>');
    createdIndex = true;
  }
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      port = server.address().port;
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  if (createdIndex) fs.rmSync(SPA_INDEX, { force: true });
  if (createdDir) fs.rmSync(BUILD_DIR, { recursive: true, force: true });
});

async function get(path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.text() };
}

const isSpaShell = (body) => body.includes('<div id="root">');

test('/trailers serves the admin SPA', async () => {
  const res = await get('/trailers');
  assert.equal(res.status, 200);
  assert.ok(isSpaShell(res.body), '/trailers must return the SPA shell');
});

test('a deep link and a refresh on a trailer section serve the SPA', async () => {
  for (const path of ['/trailers/home', '/trailers/rentals', '/trailers/money', '/trailers/more']) {
    const res = await get(path);
    assert.equal(res.status, 200, `${path} status`);
    assert.ok(isSpaShell(res.body), `${path} must return the SPA shell`);
  }
});

test('an unknown trailer sub-path still reaches the SPA, which falls back to Home', async () => {
  const res = await get('/trailers/not-a-section?filter=x');
  assert.equal(res.status, 200);
  assert.ok(isSpaShell(res.body));
});

test('the legacy /admin/trailers URLs keep working', async () => {
  for (const path of ['/admin/trailers', '/admin/trailers/money', '/admin/trailers/map?trailer=42']) {
    const res = await get(path);
    assert.equal(res.status, 200, `${path} status`);
    assert.ok(isSpaShell(res.body), `${path} must return the SPA shell`);
  }
});

test('the build emits absolute /admin asset URLs, so /trailers can load the same index', async () => {
  // One build serves /admin, /trailers and /dispatch. That only works because
  // Vite's `base` makes every asset URL absolute — relative ones would resolve
  // against /trailers/ and 404 on a deep link.
  const viteConfig = fs.readFileSync(path.resolve(__dirname, '../admin/vite.config.js'), 'utf8');
  assert.match(viteConfig, /base:\s*'\/admin\/'/, "admin/vite.config.js must keep base '/admin/'");
});

test('the catch-all does not swallow unrelated paths or the API', async () => {
  const unknown = await get('/definitely-not-a-page');
  assert.equal(unknown.status, 404);
  // /api/trailer-department/* stays an API route: unauthenticated, not the SPA.
  const api = await get('/api/trailer-department/status');
  assert.equal(api.status, 401);
});
