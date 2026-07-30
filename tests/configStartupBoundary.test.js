/**
 * Config validation boundary — importing config/config.js must NEVER terminate
 * the process (unit tests import services that import it transitively, without
 * production secrets), while assertRequiredConfig() must fail fast for the
 * production entrypoints. Also proves no secret VALUE ever appears in the
 * recorded problems.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CONFIG_PATH = path.resolve(__dirname, '../config/config.js');

function loadConfigWithEnv(env) {
  // Run in a child so this test controls the environment completely and a
  // regression back to import-time process.exit() is caught as an exit code,
  // not as this whole file dying.
  const script = `
    const config = require(${JSON.stringify(CONFIG_PATH)});
    console.log(JSON.stringify({
      imported: true,
      problems: config.configProblems,
      hasAssert: typeof config.assertRequiredConfig === 'function',
    }));
  `;
  return spawnSync(process.execPath, ['-e', script], {
    env: { ...env, PATH: process.env.PATH },
    encoding: 'utf8',
    timeout: 30000,
  });
}

test('importing config without any secrets does not exit and records the problems', () => {
  const r = loadConfigWithEnv({});
  assert.equal(r.status, 0, `import must not terminate the process: ${r.stderr}`);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.imported, true);
  assert.equal(out.hasAssert, true);
  assert.equal(out.problems.length, 1);
  assert.match(out.problems[0], /Missing required environment variables/);
  assert.match(out.problems[0], /DATABASE_URL/);
});

test('importing config with all required secrets records no problems', () => {
  const r = loadConfigWithEnv({
    DATABASE_URL: 'postgres://unit:unit@localhost:5/unit',
    JWT_SECRET: 'unit-secret',
    BOT_TOKEN: '1:unit',
    TELEGRAM_BOT_TOKEN: '2:unit',
    FACEBOOK_TOKEN_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef',
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.deepEqual(out.problems, []);
});

test('assertRequiredConfig exits 1 with the variable NAMES (never values) when secrets are missing', () => {
  const script = `require(${JSON.stringify(CONFIG_PATH)}).assertRequiredConfig(); console.log('should not reach');`;
  const r = spawnSync(process.execPath, ['-e', script], {
    env: { PATH: process.env.PATH, JWT_SECRET: 'super-secret-value-do-not-print' },
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(r.status, 1, 'startup boundary must fail fast');
  assert.match(r.stderr, /\[CONFIG\] Missing required environment variables/);
  assert.match(r.stderr, /DATABASE_URL/);
  assert.ok(!r.stdout.includes('should not reach'));
  assert.ok(!r.stderr.includes('super-secret-value-do-not-print'), 'secret values must never be printed');
});

test('a malformed chat id is a recorded problem, not an import-time exit', () => {
  const r = loadConfigWithEnv({
    DATABASE_URL: 'postgres://unit:unit@localhost:5/unit',
    JWT_SECRET: 'unit-secret',
    BOT_TOKEN: '1:unit',
    TELEGRAM_BOT_TOKEN: '2:unit',
    FACEBOOK_TOKEN_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef',
    MANAGEMENT_GROUP_ID: 'not-a-chat-id',
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  // MEDIA_STORAGE_CHAT_ID defaults to the management id, so a malformed
  // management id is correctly reported for both settings.
  assert.equal(out.problems.length, 2);
  assert.match(out.problems[0], /MANAGEMENT_GROUP_ID/);
  assert.match(out.problems[1], /MEDIA_STORAGE_CHAT_ID/);
});

test('production entrypoints call the assertion first (source-level guard)', () => {
  const fs = require('node:fs');
  for (const entry of ['index.js', 'scripts/migrate.js', 'scripts/init-db.js', 'scripts/seed-admin.js']) {
    const src = fs.readFileSync(path.resolve(__dirname, '..', entry), 'utf8');
    assert.match(src, /assertRequiredConfig\(\)/, `${entry} must fail fast at the startup boundary`);
  }
});
