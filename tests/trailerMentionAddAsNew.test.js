/**
 * "Add as a new trailer" from the unknown-message review: the route must create
 * the trailer through the SAME permission-gated manual-creation path as the
 * Trailers page (never a raw insert from the mention), then link the mention.
 * db is faked; the router is mounted in a bare Express app.
 */
process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-bot-token';
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.JWT_SECRET ||= 'test-jwt-secret';
process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

function buildApp(calls, permissions) {
  const dbPath = path.resolve(__dirname, '../database/db.js');
  const routePath = path.resolve(__dirname, '../server/routes/trailerMasterListRoutes.js');

  require.cache[dbPath] = {
    exports: {
      createDepartmentTrailer: async (data, actor) => {
        calls.create = { data, actor };
        return { id: 501, unit_number: data.unit_number };
      },
      resolveUnmatchedMention: async (id, decision) => {
        calls.resolve = { id, decision };
        return { id: Number(id), review_status: decision.review_status, linked_trailer_id: decision.linked_trailer_id };
      },
    },
  };
  delete require.cache[routePath];
  const { createTrailerMasterListRoutes } = require(routePath);

  const app = express();
  app.use(express.json());
  app.use(createTrailerMasterListRoutes({
    authMiddleware: (req, _res, next) => { req.admin = { id: 9, permissions }; next(); },
    requirePermission: () => (_req, _res, next) => next(),
  }));
  return app;
}

async function post(app, body) {
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/trailer-master-list/mentions/12/resolve`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('add-as-new creates via the manual-creation path and links the mention', async () => {
  const calls = {};
  const app = buildApp(calls, ['trailers.create', 'trailer_unmatched_mentions.manage']);
  const res = await post(app, {
    review_status: 'created',
    new_trailer: { unit_number: 'zz1234', needs_review: false },
    review_note: 'from review',
  });
  assert.equal(res.status, 200);
  assert.equal(calls.create.data.unit_number, 'zz1234');
  assert.equal(calls.resolve.decision.linked_trailer_id, 501, 'mention linked to the created trailer');
  assert.equal(res.body.trailer.id, 501);
});

test('without trailers.create the add-as-new path is refused and nothing is created', async () => {
  const calls = {};
  const app = buildApp(calls, ['trailer_unmatched_mentions.manage']);
  const res = await post(app, {
    review_status: 'created',
    new_trailer: { unit_number: 'ZZ9' },
  });
  assert.equal(res.status, 403);
  assert.equal(calls.create, undefined, 'no trailer was created');
  assert.equal(calls.resolve, undefined, 'the mention stayed pending');
});

test('a plain link resolve never touches trailer creation', async () => {
  const calls = {};
  const app = buildApp(calls, ['trailer_unmatched_mentions.manage']);
  const res = await post(app, { review_status: 'linked', linked_trailer_id: 44 });
  assert.equal(res.status, 200);
  assert.equal(calls.create, undefined);
  assert.equal(calls.resolve.decision.linked_trailer_id, 44);
});
