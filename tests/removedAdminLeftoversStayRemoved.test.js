'use strict';

/**
 * Admin-panel leftovers and an unused dependency stay removed (the
 * hidden-functions audit, block 4b, at the owner's decision).
 *
 *   AuthProvider / useAuth   a permissions context wrapped round the whole panel
 *                            that no component read; App.jsx and the sidebar
 *                            check `session.permissions` themselves.
 *   isApiError               an error predicate nothing called.
 *   sendBroadcastTest        the ADMIN CLIENT's "positional, for compatibility"
 *   (admin/src only)         wrapper round testBroadcast, which silently dropped
 *                            its parseMode argument. The bot's own
 *                            sendBroadcastTest is live — POST /api/broadcast/test
 *                            sends through it — and is checked below as such.
 *   nodemailer               left from the removed Gmail one-time code; nothing
 *                            requires it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function adminSources(dir = 'admin/src', out = []) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) adminSources(rel, out);
    else if (/\.(js|jsx|mjs)$/.test(entry.name) && !/\.test\.jsx?$/.test(entry.name)) out.push(rel);
  }
  return out;
}

test('the admin panel carries none of them', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'admin/src/context/AuthContext.jsx')), false);
  const offenders = [];
  for (const rel of adminSources()) {
    const src = read(rel);
    for (const name of ['AuthProvider', 'useAuth', 'AuthContext', 'isApiError', 'sendBroadcastTest']) {
      if (new RegExp(`\\b${name}\\b`).test(src)) offenders.push(`${rel}: ${name}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the bot\'s own test broadcast is still what the route sends through', () => {
  assert.match(read('bot/senders/broadcastSenders.js'), /async function sendBroadcastTest\(/);
  // Inside THAT route's handler: no other `router.` declaration in between.
  assert.match(read('server/routes/broadcastRoutes.js'),
    /router\.post\('\/api\/broadcast\/test',(?:(?!router\.)[\s\S])*?await sendBroadcastTest\(/);
});

test('nodemailer is not a dependency, and nothing requires it', () => {
  const pkg = JSON.parse(read('package.json'));
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    assert.equal((pkg[field] || {}).nodemailer, undefined, `package.json ${field}`);
  }
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal((lock.packages[''].dependencies || {}).nodemailer, undefined, 'the lockfile root');
  assert.equal(lock.packages['node_modules/nodemailer'], undefined, 'the lockfile tree');

  // A lazy require would only fail the day it ran, so look for one.
  const NOT_APPLICATION = new Set(['node_modules', '.git', 'build', 'dist', 'coverage', 'tests', 'docs',
    'assets', 'leads-bot', 'scratch', 'brain', 'reports', '.cursor']);
  const requirers = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (NOT_APPLICATION.has(entry.name)) continue;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(rel);
      else if (/\.(js|jsx|mjs|cjs)$/.test(entry.name) && /['"]nodemailer['"]/.test(read(rel))) requirers.push(rel);
    }
  }(''));
  assert.deepEqual(requirers, []);
});
