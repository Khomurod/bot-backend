/**
 * `npm run seed-admin` refuses to run without a real ADMIN_PASSWORD (October
 * 2026 audit). It used to create the first admin with an EMPTY password, which
 * the sign-in refuses — a "first admin" nobody could ever sign in as.
 *
 * The refusal happens before the database is touched, so this runs with a
 * DATABASE_URL that points nowhere: reaching it would fail differently.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '../scripts/seed-admin.js');

function run(adminPassword) {
  return spawnSync(process.execPath, [SCRIPT], {
    env: {
      PATH: process.env.PATH,
      DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none',
      JWT_SECRET: 'test-only',
      BOT_TOKEN: '1:test-only',
      TELEGRAM_BOT_TOKEN: '1:test-only',
      FACEBOOK_TOKEN_ENCRYPTION_KEY: 'test-only',
      ...(adminPassword === undefined ? {} : { ADMIN_PASSWORD: adminPassword }),
    },
    encoding: 'utf8',
    timeout: 20000,
  });
}

test('no ADMIN_PASSWORD, or one under 10 characters: refused, nothing created', () => {
  for (const pw of [undefined, '', 'short-pw']) {
    const res = run(pw);
    assert.equal(res.status, 1, `exit code for ${JSON.stringify(pw)}`);
    assert.match(res.stderr, /Set ADMIN_PASSWORD \(at least 10 characters\)\. Nothing was created\./);
    assert.doesNotMatch(res.stderr, /Failed to seed admin/, 'refused before any database work');
  }
});
