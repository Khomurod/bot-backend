/**
 * The health ledger and the learning suggestions against a real PostgreSQL.
 *
 * Two claims worth a database:
 *
 *   `announced_status` SURVIVES A RESTART. It is the record of what the people
 *   reading were last told, and it is the only thing standing between "Wenze
 *   fixed itself" being useful and being a stream nobody reads. Held in memory
 *   it would reset on every Render deploy — several a day — and every outage
 *   would be re-announced.
 *
 *   A SUGGESTION A PERSON DECIDED IS NOT REOPENED by the next pass finding the
 *   same pattern, which it will, because the pattern is still there.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();

const seed = (t) => createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
const loadHealth = (h) => h.loadDataLayer(['systemHealth']);
const loadLearning = (h) => h.loadDataLayer(['operationalLearning']);

test('a component nobody has observed reads as unchecked, never as healthy', async (t) => {
  if (await skipWithoutPg(t)) return;
  const h = await seed(t);
  const { systemHealth } = loadHealth(h);
  assert.equal(await systemHealth.getHealthState('ai_providers'), null);
  const s = await systemHealth.summariseHealthStates();
  assert.deepEqual({ ok: s.ok, failed: s.failed, unchecked: s.unchecked }, { ok: 0, failed: 0, unchecked: 0 });
  assert.deepEqual(s.down, [], 'nothing is down because nothing has been looked at');
});

test('WHAT THE READERS WERE LAST TOLD SURVIVES A RESTART', async (t) => {
  if (await skipWithoutPg(t)) return;
  const h = await seed(t);
  const { systemHealth } = loadHealth(h);

  await systemHealth.saveHealthState({
    component: 'ai_providers', status: 'failed', since: '2026-09-11T00:00:00Z',
    consecutiveFailures: 3, consecutiveOk: 0, announcedStatus: 'failed',
    lastError: 'all providers in cooldown', transitions: [{ at: '2026-09-11T00:00:00Z', to: 'failed' }],
    flappingSince: null,
  });

  // A fresh read is what a restarted process does.
  const after = await systemHealth.getHealthState('ai_providers');
  assert.equal(after.announcedStatus, 'failed', 'without this, the outage is announced again on every deploy');
  assert.equal(after.lastError, 'all providers in cooldown');
  assert.deepEqual(after.transitions, [{ at: '2026-09-11T00:00:00Z', to: 'failed' }]);
});

test('one row per component, updated rather than accumulated', async (t) => {
  if (await skipWithoutPg(t)) return;
  const h = await seed(t);
  const { systemHealth } = loadHealth(h);
  for (const status of ['failed', 'ok', 'failed']) {
    // eslint-disable-next-line no-await-in-loop
    await systemHealth.saveHealthState({
      component: 'notifications', status, since: '2026-09-11T00:00:00Z',
      consecutiveFailures: 1, consecutiveOk: 0, announcedStatus: status,
      lastError: null, transitions: [], flappingSince: null,
    });
  }
  const { rows } = await h.query('SELECT COUNT(*)::int AS n FROM system_health_states');
  assert.equal(rows[0].n, 1);
  assert.equal((await systemHealth.getHealthState('notifications')).status, 'failed');
});

test('the summary separates "not checked" from "fine" — only one is reassuring', async (t) => {
  if (await skipWithoutPg(t)) return;
  const h = await seed(t);
  const { systemHealth } = loadHealth(h);
  const save = (component, status) => systemHealth.saveHealthState({
    component, status, since: null, consecutiveFailures: 0, consecutiveOk: 0,
    announcedStatus: null, lastError: null, transitions: [], flappingSince: null,
  });
  await save('a', 'ok');
  await save('b', 'failed');
  await save('c', null);

  const s = await systemHealth.summariseHealthStates();
  assert.deepEqual({ ok: s.ok, failed: s.failed, unchecked: s.unchecked }, { ok: 1, failed: 1, unchecked: 1 });
  assert.deepEqual(s.down, ['b'], 'and names what is down');
});

test('only the two known statuses are storable', async (t) => {
  if (await skipWithoutPg(t)) return;
  const h = await seed(t);
  await assert.rejects(
    () => h.query("INSERT INTO system_health_states (component, status) VALUES ('x', 'wobbly')"),
    /status/,
  );
});

// ── learning suggestions ────────────────────────────────────────────────────

const suggestion = (over = {}) => ({
  kind: 'reverted_correction', subjectId: 'home_time.close_cycle',
  title: '"home time close cycle" has been undone 3 times',
  suggestion: 'Consider switching automatic correction OFF for this check.',
  evidence: { count: 3 }, ...over,
});

test('a pattern that persists updates one row rather than filing a new one each pass', async (t) => {
  if (await skipWithoutPg(t)) return;
  const h = await seed(t);
  const { operationalLearning: store } = loadLearning(h);
  await store.upsertSuggestion(suggestion());
  const second = await store.upsertSuggestion(suggestion({
    title: '"home time close cycle" has been undone 5 times', evidence: { count: 5 },
  }));
  assert.equal(second.evidence.count, 5);
  const { rows } = await h.query('SELECT COUNT(*)::int AS n FROM operational_learning_suggestions');
  assert.equal(rows[0].n, 1);
});

test('A DECIDED SUGGESTION IS NOT REOPENED by the pattern still being there', async (t) => {
  if (await skipWithoutPg(t)) return;
  const h = await seed(t);
  const { operationalLearning: store } = loadLearning(h);
  const row = await store.upsertSuggestion(suggestion());
  await store.decideSuggestion(row.id, { status: 'dismissed', decidedBy: 'boss', note: 'those three were genuine' });

  // The next pass finds the same pattern, because it is still there.
  const again = await store.upsertSuggestion(suggestion({ evidence: { count: 6 } }));
  assert.equal(again.status, 'dismissed', 'a dismissal must hold');
  assert.equal(again.decidedBy, 'boss');
  assert.equal(again.evidence.count, 6, 'but the record stays accurate');
});

test('a decision can be taken back, and that clears who decided it', async (t) => {
  if (await skipWithoutPg(t)) return;
  const h = await seed(t);
  const { operationalLearning: store } = loadLearning(h);
  const row = await store.upsertSuggestion(suggestion());
  await store.decideSuggestion(row.id, { status: 'accepted', decidedBy: 'boss', note: 'agreed' });
  const reopened = await store.decideSuggestion(row.id, { status: 'proposed' });
  assert.equal(reopened.status, 'proposed');
  assert.equal(reopened.decidedBy, null, 'a stale name on an open proposal would read as an approval');
  assert.equal(reopened.decidedAt, null);
});

test('THERE IS NO STATUS MEANING "APPLIED AUTOMATICALLY"', async (t) => {
  if (await skipWithoutPg(t)) return;
  const h = await seed(t);
  const { operationalLearning: store } = loadLearning(h);
  const row = await store.upsertSuggestion(suggestion());
  // The schema allows exactly three, and none of them is "done by the machine".
  await assert.rejects(
    () => h.query('UPDATE operational_learning_suggestions SET status = $1 WHERE id = $2', ['applied', row.id]),
    /status/,
  );
  assert.equal(await store.decideSuggestion(row.id, { status: 'applied' }), null,
    'and the data layer refuses it before SQL has to');
});

test('the summary counts what is waiting for somebody', async (t) => {
  if (await skipWithoutPg(t)) return;
  const h = await seed(t);
  const { operationalLearning: store } = loadLearning(h);
  const a = await store.upsertSuggestion(suggestion({ subjectId: 'a' }));
  await store.upsertSuggestion(suggestion({ subjectId: 'b' }));
  const c = await store.upsertSuggestion(suggestion({ subjectId: 'c' }));
  await store.decideSuggestion(a.id, { status: 'accepted', decidedBy: 'boss' });
  await store.decideSuggestion(c.id, { status: 'dismissed', decidedBy: 'boss' });

  const s = await store.summariseSuggestions();
  assert.deepEqual(s, {
    proposed: 1, accepted: 1, active: 0, awaitingAPerson: 0, reverted: 0, dismissed: 1,
  });
  assert.deepEqual((await store.listSuggestions({ status: 'proposed' })).map((r) => r.subjectId), ['b']);
});

test('EVERY ACCEPTED STATUS COUNTS AS AGREED, and the two kinds are also separable',
  async (t) => {
    if (await skipWithoutPg(t)) return;
    const h = await seed(t);
    const { operationalLearning: store } = loadLearning(h);

    // Counting only the legacy `accepted` left the Learning tab's "agreed"
    // total at zero immediately after an administrator accepted something,
    // which reads as the click having done nothing — the exact impression the
    // whole change was written to remove.
    const active = await store.upsertSuggestion(suggestion({ subjectId: 'active' }));
    const manual = await store.upsertSuggestion(suggestion({ subjectId: 'manual' }));
    await store.recordSuggestionApplied(active.id, {
      action: 'disable_auto_apply', before: { 'a.check': { present: false } }, appliedBy: 'boss',
    });
    await store.decideSuggestion(manual.id, { status: 'accepted_manual', decidedBy: 'boss' });

    const s = await store.summariseSuggestions();
    assert.equal(s.accepted, 2, 'both count as agreed');
    assert.equal(s.active, 1, 'and "the setting changed" is separable from');
    assert.equal(s.awaitingAPerson, 1, '"somebody still has to do it"');
  });

test('AN APPLIED SUGGESTION CANNOT BE DISMISSED OUT FROM UNDER ITS OWN UNDO',
  async (t) => {
    if (await skipWithoutPg(t)) return;
    const h = await seed(t);
    const { operationalLearning: store } = loadLearning(h);
    const row = await store.upsertSuggestion(suggestion({ subjectId: 'applied' }));
    await store.recordSuggestionApplied(row.id, {
      action: 'disable_auto_apply', before: { 'a.check': { present: false } }, appliedBy: 'boss',
    });

    // Two administrators with the same proposal open: one accepts and the
    // setting changes, the other's stale screen posts `dismissed`. The Undo
    // button lives on `accepted_active`, so an unconditional update would make
    // the change un-undoable from the UI while it was still in force.
    const out = await store.decideSuggestion(row.id, { status: 'dismissed', decidedBy: 'other' });
    assert.equal(out, null, 'the update matched no row');

    const still = await store.getSuggestionById(row.id);
    assert.equal(still.status, 'accepted_active', 'and the applied state survived');
    assert.ok(still.appliedBefore, 'with the values Undo needs');
  });

test('marking one announced does not disturb its decision or its evidence', async (t) => {
  if (await skipWithoutPg(t)) return;
  const h = await seed(t);
  const { operationalLearning: store } = loadLearning(h);
  const row = await store.upsertSuggestion(suggestion());
  const marked = await store.markSuggestionNotified(row.id);
  assert.ok(marked.notifiedAt);
  assert.equal(marked.status, 'proposed');
  assert.deepEqual(marked.evidence, { count: 3 });
});
