/**
 * Operations → what Wenze suggested, on the line the API holds.
 *
 * ACCEPTING RECORDS AGREEMENT. IT DOES NOT APPLY ANYTHING. An endpoint that
 * both proposed and applied would make an administrator's confirmation a
 * formality one careless click wide, and the owner's line is that important
 * business rules must not change permanently without somebody confirming.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

const ROUTE = path.resolve(__dirname, '../server/routes/operations/learningRoutes.js');
const STORE = path.resolve(__dirname, '../database/operationalLearning.js');

const ROW = {
  id: 4, kind: 'reverted_correction', subjectId: 'home_time.close_cycle',
  title: '"home time close cycle" has been undone 3 times',
  suggestion: 'Consider switching automatic correction OFF for this check.',
  evidence: { count: 3, reasons: ['wrong return date'] },
  status: 'proposed',
};

function loadApp({ rows = [ROW], decided = ROW } = {}) {
  delete require.cache[require.resolve(ROUTE)];
  const saw = { listed: [], decided: [] };
  require.cache[STORE] = {
    exports: {
      async listSuggestions(args) { saw.listed.push(args); return rows; },
      async summariseSuggestions() { return { proposed: 1, accepted: 2, dismissed: 0 }; },
      async decideSuggestion(id, args) { saw.decided.push({ id, ...args }); return decided; },
    },
  };

  const { createLearningRouter } = require(ROUTE);
  const app = express();
  app.use(express.json());
  app.use('/api/operations', createLearningRouter({
    authMiddleware: (req, _res, next) => { req.admin = { username: 'boss' }; next(); },
  }));
  return { app, saw };
}

async function call(app, method, url, body) {
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally { server.close(); }
}

test('a proposal comes back with its EVIDENCE — without it, it is only an opinion', async () => {
  const { app } = loadApp();
  const res = await call(app, 'GET', '/api/operations/learning');
  assert.equal(res.status, 200);
  assert.equal(res.body.suggestions[0].evidence.count, 3);
  assert.deepEqual(res.body.suggestions[0].evidence.reasons, ['wrong return date']);
  assert.equal(res.body.summary.proposed, 1);
});

test('a decision records who made it and what they said', async () => {
  const { app, saw } = loadApp();
  const res = await call(app, 'POST', '/api/operations/learning/4/decide', {
    status: 'accepted', note: 'agreed, it keeps picking the wrong cycle',
  });
  assert.equal(res.status, 200);
  assert.deepEqual(saw.decided[0], {
    id: 4, status: 'accepted', decidedBy: 'boss',
    note: 'agreed, it keeps picking the wrong cycle',
  });
});

test('a decision can be taken back', async () => {
  const { app, saw } = loadApp();
  await call(app, 'POST', '/api/operations/learning/4/decide', { status: 'proposed' });
  assert.equal(saw.decided[0].status, 'proposed');
});

test('an unknown status is refused with the list of real ones', async () => {
  const { app, saw } = loadApp();
  const res = await call(app, 'POST', '/api/operations/learning/4/decide', { status: 'applied' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /accepted, dismissed, proposed/);
  assert.equal(res.body.field, 'status');
  assert.deepEqual(saw.decided, []);
});

test('a nonsense id never reaches SQL', async () => {
  const { app, saw } = loadApp();
  for (const id of ['abc', '0', '-3']) {
    // eslint-disable-next-line no-await-in-loop
    const res = await call(app, 'POST', `/api/operations/learning/${id}/decide`, { status: 'accepted' });
    assert.equal(res.status, 400, id);
  }
  assert.deepEqual(saw.decided, []);
});

test('an id that does not exist is a 404, not a silent success', async () => {
  const { app } = loadApp({ decided: null });
  const res = await call(app, 'POST', '/api/operations/learning/99/decide', { status: 'accepted' });
  assert.equal(res.status, 404);
});

test('a note is capped rather than stored unbounded', async () => {
  const { app, saw } = loadApp();
  await call(app, 'POST', '/api/operations/learning/4/decide', {
    status: 'dismissed', note: 'x'.repeat(2000),
  });
  assert.equal(saw.decided[0].note.length, 500);
});

test('THERE IS NO ENDPOINT THAT APPLIES A SUGGESTION', () => {
  const src = require('node:fs').readFileSync(ROUTE, 'utf8');
  const routes = [...src.matchAll(/router\.(get|post|put|patch|delete)\('([^']+)'/g)]
    .map((m) => `${m[1].toUpperCase()} ${m[2]}`);
  assert.deepEqual(routes.sort(), ['GET /learning', 'POST /learning/:id/decide']);
  // And the file reaches for nothing that could change a rule.
  for (const forbidden of ['updateCheckSettings', 'setCheckEnabled', 'applyCorrection', 'updateAiSettings']) {
    assert.ok(!src.includes(forbidden), `must never call ${forbidden}`);
  }
});
