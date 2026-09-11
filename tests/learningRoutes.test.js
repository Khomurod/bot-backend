/**
 * Operations → what Wenze suggested, on the line the API holds.
 *
 * THE LINE MOVED, AND IT IS IMPORTANT TO SAY WHERE TO. It used to be
 * "accepting applies nothing", and the route's comment treated that as the
 * safety property. It is half of one: the guarantee worth keeping is that AI
 * cannot change a business rule BY ITSELF, kept by requiring an
 * administrator's confirmation — not by making the confirmation inert. Somebody
 * who accepted "switch automatic correction off for this check" believed they
 * had switched it off; they had written a word in a table.
 *
 * So the line is now:
 *
 *   - a suggestion carries a NAMED action or none, decided by the pure
 *     `lib/operations/learning.js`, and naming is not doing;
 *   - only an administrator's POST to /accept, BEHIND THE APPLY GATE, runs it;
 *   - the action comes from a registry holding exactly one — turn a check's
 *     automatic correction OFF — with nothing that turns automation on and
 *     nothing touching pay, employment, hiring, discipline or code;
 *   - a suggestion with no action becomes `accepted_manual` and says so,
 *     rather than claiming a change that did not happen.
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

const DECISION = path.resolve(__dirname, '../services/operations/learningDecision.js');

function loadApp({ rows = [ROW], decided = ROW, accept, revert } = {}) {
  delete require.cache[require.resolve(ROUTE)];
  const saw = { listed: [], decided: [], accepted: [], reverted: [], gates: [] };
  require.cache[STORE] = {
    exports: {
      async listSuggestions(args) { saw.listed.push(args); return rows; },
      async summariseSuggestions() { return { proposed: 1, accepted: 2, dismissed: 0 }; },
      async decideSuggestion(id, args) { saw.decided.push({ id, ...args }); return decided; },
      async getSuggestionById(id) { return rows.find((r) => r.id === id) || null; },
    },
  };
  require.cache[DECISION] = {
    exports: {
      async acceptSuggestion(id, args) {
        saw.accepted.push({ id, ...args });
        return accept === undefined
          ? { suggestion: { ...ROW, status: 'accepted_active' }, applied: true, detail: 'switched off' }
          : accept;
      },
      async revertSuggestion(id, args) {
        saw.reverted.push({ id, ...args });
        return revert === undefined
          ? { suggestion: { ...ROW, status: 'reverted' }, reverted: true, detail: '1 setting(s) put back.' }
          : revert;
      },
    },
  };

  const { createLearningRouter } = require(ROUTE);
  const app = express();
  app.use(express.json());
  app.use('/api/operations', createLearningRouter({
    authMiddleware: (req, _res, next) => { req.admin = { username: 'boss' }; next(); },
    applyMiddleware: (req, _res, next) => {
      saw.gates.push(req.path);
      req.admin = { username: 'boss', id: 9 };
      next();
    },
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
    status: 'dismissed', note: 'not worth changing for three rows',
  });
  assert.equal(res.status, 200);
  assert.deepEqual(saw.decided[0], {
    id: 4, status: 'dismissed', decidedBy: 'boss',
    note: 'not worth changing for three rows',
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
  assert.match(res.body.error, /dismissed, proposed/);
  assert.match(res.body.error, /Use \/accept to accept/,
    'accepting may change a setting, so it goes through the gate that guards changes');
  assert.equal(res.body.field, 'status');
  assert.deepEqual(saw.decided, []);
});

test('a nonsense id never reaches SQL', async () => {
  const { app, saw } = loadApp();
  for (const id of ['abc', '0', '-3']) {
    // eslint-disable-next-line no-await-in-loop
    const res = await call(app, 'POST', `/api/operations/learning/${id}/decide`, { status: 'dismissed' });
    assert.equal(res.status, 400, id);
  }
  assert.deepEqual(saw.decided, []);
});

test('an id that does not exist is a 404, not a silent success', async () => {
  const { app } = loadApp({ decided: null, rows: [] });
  const res = await call(app, 'POST', '/api/operations/learning/99/decide', { status: 'dismissed' });
  assert.equal(res.status, 404);

  const missing = loadApp({ accept: null });
  const acc = await call(missing.app, 'POST', '/api/operations/learning/99/accept', {});
  assert.equal(acc.status, 404);
});

test('a note is capped rather than stored unbounded', async () => {
  const { app, saw } = loadApp();
  await call(app, 'POST', '/api/operations/learning/4/decide', {
    status: 'dismissed', note: 'x'.repeat(2000),
  });
  assert.equal(saw.decided[0].note.length, 500);
});

// ── accepting, and the gate in front of it ───────────────────────────────────

test('ACCEPT IS BEHIND THE APPLY GATE, not the read gate', async () => {
  const { app, saw } = loadApp();
  const res = await call(app, 'POST', '/api/operations/learning/4/accept', { note: 'yes' });
  assert.equal(res.status, 200);
  assert.deepEqual(saw.gates, ['/learning/4/accept'],
    'seeing a proposal and changing a setting are different permissions, exactly '
    + 'as they are for corrections');
  assert.equal(saw.accepted[0].id, 4);
  assert.equal(saw.accepted[0].admin.username, 'boss');
});

test('the answer says whether anything ACTUALLY changed', async () => {
  const applied = loadApp();
  const a = await call(applied.app, 'POST', '/api/operations/learning/4/accept', {});
  assert.equal(a.body.applied, true);
  assert.equal(a.body.suggestion.status, 'accepted_active');

  const manual = loadApp({
    accept: {
      suggestion: { ...ROW, status: 'accepted_manual' },
      applied: false,
      detail: 'Agreement recorded. Nothing was changed automatically.',
    },
  });
  const m = await call(manual.app, 'POST', '/api/operations/learning/4/accept', {});
  assert.equal(m.body.applied, false);
  assert.equal(m.body.suggestion.status, 'accepted_manual');
  assert.match(m.body.detail, /Nothing was changed automatically/,
    'a suggestion nobody can apply must say so rather than look identical to one '
    + 'that was applied');
});

test('what was applied can be undone, through the same gate', async () => {
  const { app, saw } = loadApp();
  const res = await call(app, 'POST', '/api/operations/learning/4/revert', { note: 'wrong call' });
  assert.equal(res.status, 200);
  assert.equal(res.body.reverted, true);
  assert.deepEqual(saw.gates, ['/learning/4/revert']);
});

test('THE ROUTE ITSELF STILL CHANGES NOTHING — it delegates to the one registry', () => {
  const src = require('node:fs').readFileSync(ROUTE, 'utf8');
  const routes = [...src.matchAll(/router\.(get|post|put|patch|delete)\('([^']+)'/g)]
    .map((m) => `${m[1].toUpperCase()} ${m[2]}`);
  assert.deepEqual(routes.sort(), [
    'GET /learning', 'POST /learning/:id/accept', 'POST /learning/:id/decide',
    'POST /learning/:id/revert',
  ]);
  // The route reaches for nothing that could change a rule directly. Everything
  // it can do goes through `learningDecision`, and everything THAT can do goes
  // through a registry whose whole contents are asserted in
  // tests/learningActions.test.js.
  for (const forbidden of [
    'upsertCheckSettings', 'applyCorrection', 'updateAiSettings', 'driver_profiles',
  ]) {
    assert.ok(!src.includes(forbidden), `must never call ${forbidden}`);
  }
});

test('DISMISSING A SUGGESTION SOMEBODY ELSE ALREADY APPLIED IS A 409, not a silent overwrite',
  async () => {
    // Two administrators with the same proposal open. One accepts and the
    // setting changes; the other's stale screen posts `dismissed`. An
    // unconditional update would hide `accepted_active` while the setting
    // stayed changed — and the Undo button lives on that state, so the change
    // would become un-undoable from the UI while still being in force.
    const { app } = loadApp({
      decided: null,
      rows: [{ ...ROW, status: 'accepted_active' }],
    });
    const res = await call(app, 'POST', '/api/operations/learning/4/decide', { status: 'dismissed' });
    assert.equal(res.status, 409);
    assert.equal(res.body.status, 'accepted_active');
    assert.match(res.body.error, /Undo/, 'and it says what to do instead');
  });
