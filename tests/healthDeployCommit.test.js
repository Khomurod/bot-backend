/**
 * /api/health names the commit it is running.
 *
 * `main` auto-deploys to Render, and until now the only evidence that a merge
 * was actually live was a process uptime that happened to line up with the merge
 * time. Render sets RENDER_GIT_COMMIT on every deploy; surfacing it turns "it is
 * probably deployed" into a SHA that can be compared with `git log`.
 *
 * Absent env → `null`, never a placeholder string: a local run must not look
 * like a deploy of some commit called "unknown".
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

const HEALTH_PATH = path.resolve(__dirname, '../server/routes/healthRoutes.js');

function loadApp() {
  delete require.cache[HEALTH_PATH];
  const { createHealthRoutes } = require(HEALTH_PATH);
  const app = express();
  app.use(createHealthRoutes({
    db: { async ping() { return true; } },
    config: { metaAppId: null, metaAppSecret: null },
    countExhaustedInternalAlerts: async () => ({ count: 0, oldestAt: null }),
  }));
  return app;
}

async function getHealth(app) {
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/health`);
    return await res.json();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function withEnv(value, fn) {
  const before = process.env.RENDER_GIT_COMMIT;
  if (value === undefined) delete process.env.RENDER_GIT_COMMIT;
  else process.env.RENDER_GIT_COMMIT = value;
  return fn().finally(() => {
    if (before === undefined) delete process.env.RENDER_GIT_COMMIT;
    else process.env.RENDER_GIT_COMMIT = before;
  });
}

test('the deployed commit is reported, full and short', () => withEnv(
  'ca07a1fcee957e884de3f4925e31c179b7a69977',
  async () => {
    const json = await getHealth(loadApp());
    assert.equal(json.commit.sha, 'ca07a1fcee957e884de3f4925e31c179b7a69977');
    assert.equal(json.commit.short, 'ca07a1f');
  },
));

test('no deploy metadata means null, not a made-up value', () => withEnv(undefined, async () => {
  const json = await getHealth(loadApp());
  assert.deepEqual(json.commit, { sha: null, short: null });
}));
