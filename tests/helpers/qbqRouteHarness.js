/**
 * Shared harness for the /qbq HTTP suites.
 *
 * Mounts the real routers the way server/api.js does — page routes at the root,
 * API routes under /api/qbq with a full-admin guard — against an in-memory
 * stand-in for database/qbqPresentation. That keeps route wiring, validation,
 * auth gating and the remote protocol testable without a database, while the
 * real SQL is covered separately by tests/qbqPresentationPg.test.js.
 *
 * Each caller gets a FRESH router instance: the rate limiters are module-level
 * state inside qbqRoutes.js, so a shared copy would leak throttle counts from
 * one test into the next.
 */

'use strict';

const http = require('node:http');
const path = require('node:path');
const express = require('express');

const ROUTES_PATH = path.resolve(__dirname, '../../server/routes/qbqRoutes.js');
const DB_PATH = path.resolve(__dirname, '../../database/qbqPresentation.js');
const SESSIONS_PATH = path.resolve(__dirname, '../../services/qbq/remoteSessions.js');

const GOOD_TOKEN = 'good-admin-token';
const authHeaders = { Authorization: `Bearer ${GOOD_TOKEN}`, 'Content-Type': 'application/json' };
const jsonHeaders = { 'Content-Type': 'application/json' };

/** In-memory twin of database/qbqPresentation with the same UPSERT semantics. */
function createDbStub(options = {}) {
  const rows = new Map();
  const stub = {
    DEFAULT_DECK_KEY: 'sos-offline-v2',
    calls: [],
    rows,
    async listOverrides() {
      stub.calls.push({ name: 'listOverrides' });
      if (options.failList) throw new Error('database is down');
      return [...rows.values()].sort((a, b) => a.slideIndex - b.slideIndex);
    },
    async getOverride(elementPath) {
      return rows.get(elementPath) || null;
    },
    async upsertOverride(input) {
      stub.calls.push({ name: 'upsertOverride', input });
      if (options.failUpsert) throw new Error('write failed');
      const saved = {
        elementPath: input.elementPath,
        slideIndex: input.slideIndex,
        content: input.content,
        updatedAt: new Date('2026-07-31T00:00:00Z'),
      };
      rows.set(input.elementPath, saved);
      return saved;
    },
  };
  return stub;
}

function loadRouters(dbStub) {
  delete require.cache[ROUTES_PATH];
  delete require.cache[DB_PATH];
  require.cache[DB_PATH] = {
    id: DB_PATH, filename: DB_PATH, loaded: true, exports: dbStub,
  };
  const routers = require(ROUTES_PATH);
  delete require.cache[ROUTES_PATH];
  delete require.cache[DB_PATH];
  return routers;
}

/**
 * Start a real HTTP server with the real routers.
 *
 * @param {object} options
 * @param {object} [options.db] db stub (defaults to a fresh empty one)
 * @param {Function} fn receives (base, context)
 */
async function withQbqServer(options, fn) {
  const dbStub = options.db || createDbStub();
  // Sessions are process-global by design; start every test from empty.
  require(SESSIONS_PATH).__resetForTests();

  const { createQbqPageRoutes, createQbqApiRoutes } = loadRouters(dbStub);

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.set('trust proxy', 1);

  const fakeAuth = (req, res, next) => {
    if (req.headers.authorization === `Bearer ${GOOD_TOKEN}`) {
      req.admin = { id: 42, username: 'tester', permissions: ['admin.full_access'] };
      return next();
    }
    if (req.headers.authorization === 'Bearer weak-token') {
      // Authenticated but WITHOUT admin.full_access — api.js composes
      // authMiddleware with requirePermission, so the harness mirrors a 403.
      return res.status(403).json({ error: 'Missing permission: admin.full_access' });
    }
    return res.status(401).json({ error: 'Unauthorized' });
  };

  app.use(createQbqPageRoutes());
  app.use('/api/qbq', createQbqApiRoutes({ authMiddleware: fakeAuth }));

  // Stand-ins for the neighbouring routes, so a test can prove /qbq does not
  // swallow them.
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.get(['/admin', '/admin/*', '/questions', '/questions/*', '/answers', '/answers/*'],
    (req, res) => res.type('html').send('<html>spa</html>'));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, { db: dbStub });
  } finally {
    // SSE responses stay open by design, and keep-alive sockets linger after a
    // fetch resolves — server.close() alone would wait for both forever.
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

module.exports = {
  GOOD_TOKEN,
  authHeaders,
  jsonHeaders,
  createDbStub,
  loadRouters,
  withQbqServer,
};
