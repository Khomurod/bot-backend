/**
 * "Did it ARRIVE", not "did the pass run".
 *
 * On 2026-10-02 /api/health said `systems.failed: 0` while the Samsara poller
 * had kept 0 of 8 safety events and none of 29 home-time notices had reached
 * the managers. Both workers ran on time. These observations judge the output.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const obs = require('../services/operations/healthObservations');

const NOW = Date.parse('2026-09-20T18:00:00Z');
const BOOTED = NOW - 86400000;
const minutesAgo = (m) => new Date(NOW - m * 60000).toISOString();
const run = (over = {}) => ({
  lastFinishedAt: minutesAgo(5), lastStartedAt: minutesAgo(5), lastStatus: 'ok',
  consecutiveFailures: 0, runsTotal: 10, failuresTotal: 0, ...over,
});
const find = (list, key) => list.find((o) => o.component === key);

/** Only what these two observations read; everything else answers unknown. */
function deps({
  runMap = new Map(), managerNotices = {}, latestNoticeFailure = null, safetyRecordedSince = null,
} = {}) {
  return {
    runs: {
      async getRunMap() { return runMap; },
      async getRun(key) { return runMap.get(key) || null; },
    },
    homeTimeObservability: { async summariseManagerNotices() { return managerNotices; } },
    homeTime: { async latestNoticeFailure() { return latestNoticeFailure; } },
    safety: { async countRecordedSince() { return safetyRecordedSince; } },
  };
}

// ── "did it arrive", not "did the pass run" ─────────────────────────────────

const pollerBeat = (summary) => run({ lastSummary: { seenSince: minutesAgo(300), ...summary } });

test('a poller that runs on time while every event is dropped is NOT healthy', async () => {
  const runMap = new Map([['samsara_safety_pipeline', pollerBeat({ eventsSeenTotal: 8, recordingRefused: 8 })]]);
  const all = await obs.gatherAllObservations(deps({ runMap, safetyRecordedSince: 0 }), { now: NOW, bootedAt: BOOTED });
  const safety = find(all, 'samsara_safety_pipeline');
  assert.equal(safety.state, 'needs_human_attention');
  assert.equal(safety.ok, false);
  assert.match(safety.detail, /picked up 8 event\(s\).*only 0 row\(s\)/);
  assert.match(safety.detail, /refused 8 of them for a missing field/);
});

test('a poller whose events are all kept stays healthy', async () => {
  const runMap = new Map([['samsara_safety_pipeline', pollerBeat({ eventsSeenTotal: 8 })]]);
  const all = await obs.gatherAllObservations(deps({ runMap, safetyRecordedSince: 8 }), { now: NOW, bootedAt: BOOTED });
  assert.equal(find(all, 'samsara_safety_pipeline').state, 'healthy');
});

test('the managers not being told is raised, with what Telegram said', async () => {
  const all = await obs.gatherAllObservations(deps({
    managerNotices: {
      arrived_home: { rows: 16, delivered: 0, pending: 1, failed: 15 },
      back_on_road: { rows: 9, delivered: 0, pending: 1, failed: 8 },
      request: { rows: 4, delivered: 0, pending: 1, failed: 3 },
    },
    latestNoticeFailure: { lastError: '400: Bad Request: chat not found', createdAt: minutesAgo(10) },
  }), { now: NOW, bootedAt: BOOTED });
  const notices = find(all, 'home_time_manager_notices');
  assert.equal(notices.state, 'needs_human_attention');
  assert.equal(notices.critical, true, 'so the self-healing watch announces it');
  assert.match(notices.detail, /none of the 29/);
  assert.match(notices.detail, /Telegram said: "400: Bad Request: chat not found"/);
});

test('notices being delivered read healthy; an unreadable outbox reads unknown', async () => {
  const fine = await obs.gatherAllObservations(deps({
    managerNotices: { arrived_home: { rows: 5, delivered: 5, pending: 0, failed: 0 } },
  }), { now: NOW, bootedAt: BOOTED });
  assert.equal(find(fine, 'home_time_manager_notices').state, 'healthy');

  const d = deps();
  d.homeTimeObservability = { async summariseManagerNotices() { throw new Error('relation does not exist'); } };
  const unread = await obs.gatherAllObservations(d, { now: NOW, bootedAt: BOOTED });
  assert.equal(find(unread, 'home_time_manager_notices').state, 'cannot_determine');
});
