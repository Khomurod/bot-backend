/**
 * `events: 0` HAS TWO CAUSES AND ONLY ONE IS FINE.
 *
 * The Samsara poller is a SEPARATE Render service sharing only this database.
 * It already wrote how many new events each poll found into its heartbeat, and
 * nothing read it — so a fortnight with no incidents and a recorder silently
 * failing produced exactly the same zero on the hub's side. That is the
 * ambiguity the heartbeat was added to remove, and it was left half-finished.
 *
 * Split out of healthOperationsBlock.test.js, which reached the 500-line cap:
 * that file is about the shape and safety of the whole block, this one about
 * one question inside it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { getOperationsHealth } = require('../services/operations/healthSummary');
const { summaryDeps } = require('./helpers/operationsHealthDeps');


/**
 * `events: 0` HAS TWO CAUSES AND ONLY ONE IS FINE.
 *
 * The Samsara poller is a separate Render service sharing only this database.
 * It already wrote how many new events each poll found into its heartbeat, and
 * nothing read it — so a fortnight with no incidents and a recorder silently
 * failing produced exactly the same zero. That is the ambiguity the heartbeat
 * was added to remove, and it was left half-finished.
 */
test('the safety block says what the POLLER saw, not only what was stored', async () => {
  const s = await getOperationsHealth(summaryDeps());
  assert.equal(s.safety.poller.available, true);
  assert.equal(s.safety.poller.seenLastPoll, 4);
  assert.equal(s.safety.poller.status, 'ok');
  assert.equal(s.safety.poller.recordingReady, null, 'unknown until the poller reports it');
  assert.ok(s.safety.poller.lastBeatAt, 'and when it last said so');
});

test('a poller that has never reported says exactly that', async () => {
  const s = await getOperationsHealth(summaryDeps({ safetyPollerRun: null }));
  assert.equal(s.safety.poller.available, false);
  assert.match(s.safety.poller.reason, /never reported/);
});

/** The heartbeat carries counts only — no event, driver, vehicle or media. */
test('the poller block leaks nothing about an event', async () => {
  const s = await getOperationsHealth(summaryDeps({
    safetyPollerRun: {
      lastStatus: 'ok', lastFinishedAt: '2026-09-20T17:41:00.000Z',
      lastSummary: { newEvents: 2, driverName: 'A Driver', vehicleId: 'v-9' },
    },
  }));
  const flat = JSON.stringify(s.safety.poller);
  assert.ok(!flat.includes('A Driver'), 'a name must never reach a public endpoint');
  assert.ok(!flat.includes('v-9'));
  assert.equal(s.safety.poller.seenLastPoll, 2);
});

/**
 * The two causes of an empty safety table, named rather than inferred.
 */
test('events seen but the store not ready is a RECORDER problem, said outright', async () => {
  const s = await getOperationsHealth(summaryDeps({
    safetyPollerRun: {
      lastStatus: 'ok', lastFinishedAt: '2026-09-20T17:41:00.000Z',
      lastSummary: { newEvents: 6, recordingReady: false },
    },
  }));
  assert.equal(s.safety.poller.seenLastPoll, 6);
  assert.equal(s.safety.poller.recordingReady, false);
});

test('nothing seen and the store ready is a quiet fleet', async () => {
  const s = await getOperationsHealth(summaryDeps({
    safetyPollerRun: {
      lastStatus: 'ok', lastFinishedAt: '2026-09-20T17:41:00.000Z',
      lastSummary: { newEvents: 0, recordingReady: true },
    },
  }));
  assert.equal(s.safety.poller.seenLastPoll, 0);
  assert.equal(s.safety.poller.recordingReady, true);
});

// ── reconciling what the poller saw with what was stored ───────────────────

/**
 * TWO NUMBERS ON DIFFERENT SCALES CANNOT DISAGREE USEFULLY.
 *
 * `seenLastPoll` is the last poll only and is almost always zero; `events`
 * beside it counts fourteen days of rows. So "the poller picked up events and
 * none of them were stored" was invisible in aggregate — the only way to notice
 * was to already suspect it, which is not a health signal.
 *
 * The poller now reports a running total since it booted, and the instant it
 * booted; the hub counts the rows written in that same period. One subtraction.
 */
test('events seen and not stored is named outright', async () => {
  const s = await getOperationsHealth(summaryDeps({
    safetyPollerRun: {
      lastStatus: 'ok',
      lastFinishedAt: '2026-09-20T17:41:00.000Z',
      lastSummary: { newEvents: 0, eventsSeenTotal: 9, seenSince: '2026-09-20T10:00:00.000Z' },
    },
    safetyRecordedSince: 4,
  }));

  const r = s.safety.poller;
  assert.equal(r.seenSinceBoot, 9);
  assert.equal(r.recordedSinceBoot, 4);
  assert.equal(r.reconciliation.state, 'events_lost');
  assert.match(r.reconciliation.reason, /arriving and not being stored/);
});

test('matching counts reconcile', async () => {
  const s = await getOperationsHealth(summaryDeps({
    safetyPollerRun: {
      lastStatus: 'ok',
      lastFinishedAt: '2026-09-20T17:41:00.000Z',
      lastSummary: { newEvents: 0, eventsSeenTotal: 3, seenSince: '2026-09-20T10:00:00.000Z' },
    },
    safetyRecordedSince: 3,
  }));
  assert.equal(s.safety.poller.reconciliation.state, 'reconciled');
});

/** A quiet fleet reconciles at zero, which is a different sentence from a fault. */
test('nothing seen and nothing stored reconciles', async () => {
  const s = await getOperationsHealth(summaryDeps({
    safetyPollerRun: {
      lastStatus: 'ok',
      lastFinishedAt: '2026-09-20T17:41:00.000Z',
      lastSummary: { newEvents: 0, eventsSeenTotal: 0, seenSince: '2026-09-20T10:00:00.000Z' },
    },
    safetyRecordedSince: 0,
  }));
  const r = s.safety.poller;
  assert.equal(r.reconciliation.state, 'reconciled');
  assert.match(r.reconciliation.reason, /picked up nothing/);
});

/** A missing number is never a verdict — in either direction. */
test('an older poller with no running total CANNOT DETERMINE, rather than passing', async () => {
  const s = await getOperationsHealth(summaryDeps({
    safetyPollerRun: {
      lastStatus: 'ok', lastFinishedAt: '2026-09-20T17:41:00.000Z',
      lastSummary: { newEvents: 0 },
    },
  }));
  assert.equal(s.safety.poller.reconciliation.state, 'cannot_determine');
});

test('a row count that could not be read CANNOT DETERMINE, not "events lost"', async () => {
  const s = await getOperationsHealth(summaryDeps({
    safetyPollerRun: {
      lastStatus: 'ok', lastFinishedAt: '2026-09-20T17:41:00.000Z',
      lastSummary: { newEvents: 0, eventsSeenTotal: 5, seenSince: '2026-09-20T10:00:00.000Z' },
    },
    safetyRecordedSince: null,
  }));
  const r = s.safety.poller;
  assert.equal(r.reconciliation.state, 'cannot_determine');
  assert.match(r.reconciliation.reason, /could not be counted/);
});
