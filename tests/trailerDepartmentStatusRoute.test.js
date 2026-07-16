/**
 * GET /api/trailer-department/status must survive the disabled-department guard
 * so the admin panel can tell "turned off" apart from "request failed", while
 * every other department endpoint stays blocked when the flag is false.
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
const express = require('express');
const { createTrailerDepartmentRoutes } = require('../server/routes/trailerDepartmentRoutes');

function buildApp({ enabled }) {
  const app = express();
  app.use(express.json());
  const authMiddleware = (req, res, next) => {
    if (req.headers.authorization !== 'Bearer good') {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    req.admin = { id: 1, username: 'tester', permissions: ['trailers.view'] };
    next();
  };
  const requirePermission = (...needed) => (req, res, next) => {
    const have = new Set(req.admin?.permissions || []);
    if (!needed.some((permission) => have.has(permission))) {
      return res.status(403).json({ error: 'Missing permission' });
    }
    next();
  };
  app.use(createTrailerDepartmentRoutes({
    db: { listDepartmentTrailers: async () => [] },
    config: { trailerDepartmentEnabled: enabled },
    authMiddleware,
    requirePermission,
    telegram: { sendMessage: async () => ({ message_id: 1 }) },
  }));
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

async function get(port, p, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('the status endpoint requires authentication', async () => {
  const { server, port } = await listen(buildApp({ enabled: true }));
  try {
    const anonymous = await get(port, '/api/trailer-department/status');
    assert.equal(anonymous.status, 401);
  } finally {
    server.close();
  }
});

test('status reports enabled and does not leak other configuration', async () => {
  const { server, port } = await listen(buildApp({ enabled: true }));
  try {
    const res = await get(port, '/api/trailer-department/status', { authorization: 'Bearer good' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { enabled: true });
  } finally {
    server.close();
  }
});

test('status still answers while the rest of the department is disabled', async () => {
  const { server, port } = await listen(buildApp({ enabled: false }));
  try {
    const status = await get(port, '/api/trailer-department/status', { authorization: 'Bearer good' });
    assert.equal(status.status, 200);
    assert.deepEqual(status.body, { enabled: false });

    const trailers = await get(port, '/api/trailer-department/trailers', { authorization: 'Bearer good' });
    assert.equal(trailers.status, 404);
    assert.equal(trailers.body.error, 'Trailer Department is disabled.');
  } finally {
    server.close();
  }
});

test('the feature guard still allows department endpoints when enabled', async () => {
  const { server, port } = await listen(buildApp({ enabled: true }));
  try {
    const trailers = await get(port, '/api/trailer-department/trailers', { authorization: 'Bearer good' });
    assert.equal(trailers.status, 200);
    assert.deepEqual(trailers.body, { trailers: [] });
  } finally {
    server.close();
  }
});
