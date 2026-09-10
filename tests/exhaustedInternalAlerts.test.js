/**
 * Giving up, on purpose and on the record.
 *
 * 101 internal home-time alerts failed with `400: Bad Request: chat not found`,
 * every one at attempts = 6 = MAX_ATTEMPTS, because
 * `internal_clarification_group_id` held `5052301861` where the chat is
 * `-5052301861`. Migration 0014 fixed the id. It did not, and must not, fix the
 * pile: re-driving months of stale home-time alerts into a live staff chat would
 * be its own incident.
 *
 * So they need somewhere to go. `'failed'` is the outbox's "we are still
 * looking at this" state and it is what `/api/health` reports, so leaving 98
 * rows there reports 98 problems forever — and a number that never moves is one
 * nobody reads, which is precisely the failure that let the original 101 sit
 * unnoticed for months.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { checkExhaustedInternalAlerts } = require('../services/operations/checks/homeTime');

const pile = (over = {}) => ({
  count: 98,
  oldestAt: '2026-04-01T00:00:00Z',
  requestIds: Array.from({ length: 98 }, (_, i) => i + 1),
  lastError: '400: Bad Request: chat not found',
  ...over,
});

test('ONE finding for the whole pile, not one per alert', () => {
  // They are not 98 problems. They are one problem that happened 98 times, and
  // 98 findings would bury every other row on the page under a dropped minus.
  const found = checkExhaustedInternalAlerts({ exhaustedInternalAlerts: pile() });
  assert.equal(found.length, 1);
  assert.equal(found[0].subjectType, 'outbox');
  assert.match(found[0].subjectId, /^home_time_internal_alerts:[0-9a-f]{12}$/,
    'the queue, plus a digest of the pile — one row per incident across sweeps');
  assert.match(found[0].title, /98 internal home-time alert/);
});

test('the finding says WHY, using the error the queue itself recorded', () => {
  const [found] = checkExhaustedInternalAlerts({ exhaustedInternalAlerts: pile() });
  assert.equal(found.evidence.lastError, '400: Bad Request: chat not found');
  assert.equal(found.evidence.oldestAt, '2026-04-01T00:00:00Z');
  assert.equal(found.evidence.count, 98);
});

test('the proposed change is terminal, and explicitly NOT a re-send', () => {
  const [found] = checkExhaustedInternalAlerts({ exhaustedInternalAlerts: pile() });
  assert.equal(found.proposedChange.from, 'failed');
  assert.equal(found.proposedChange.to, 'abandoned');
  assert.match(found.proposedChange.note, /NOT re-send/i);
  assert.equal(found.tier, 'auto', 'it records that they are terminal; it invents nothing');
});

test('an empty queue files nothing', () => {
  assert.deepEqual(checkExhaustedInternalAlerts({ exhaustedInternalAlerts: pile({ count: 0, requestIds: [] }) }), []);
  assert.deepEqual(checkExhaustedInternalAlerts({}), []);
  assert.deepEqual(checkExhaustedInternalAlerts({ exhaustedInternalAlerts: null }), []);
});

test('the pile is one finding, so the per-run cap cannot silently block it', () => {
  // Unlike the 65-cycle repair, where 65 eligible findings against a default cap
  // of 50 reported `eligible: 0` and looked exactly like "found nothing".
  const found = checkExhaustedInternalAlerts({ exhaustedInternalAlerts: pile({ count: 5000 }) });
  assert.equal(found.length, 1);
});

test('the check is registered, or it never runs', () => {
  const homeTime = require('../services/operations/checks/homeTime');
  assert.ok(homeTime.CHECK_KEYS.includes('home_time.exhausted_internal_alerts'),
    'an unregistered key is also never resolved when the condition clears');
  const all = homeTime.runHomeTimeChecks({
    roadHistory: [], homeStatus: [], groupsById: new Map(), groups: [], profiles: [],
    settings: {}, now: new Date(), exhaustedInternalAlerts: pile(),
  });
  assert.equal(all.filter((f) => f.checkKey === 'home_time.exhausted_internal_alerts').length, 1);
});

test('the check has an action, and the action is the abandon one', () => {
  const { actionForCheck } = require('../services/operations/corrections/actions');
  const action = actionForCheck('home_time.exhausted_internal_alerts');
  assert.ok(action, 'a check with no action is reported and never acted on');
  assert.equal(action.key, 'home_time.abandon_exhausted_alerts');
  assert.equal(action.tier, 'auto');
  assert.match(action.describe({ requestIds: [1, 2, 3] }), /NOT re-sent/i);
});

// ─── two ways this could have shipped and done nothing ───────────────────────

test('the finding carries a payload, or the action can never run', () => {
  // `payloadFor` is how BOTH `POST /findings/:id/apply` and `runAutoCorrections`
  // get their arguments. A check key it does not know returns null — the admin
  // route then answers "this finding carries no proposed change" and the batch
  // counts it under `skipped.noPayload`. Registering the action is not enough;
  // without this the correction is unreachable from every path there is.
  const { payloadFor } = require('../services/operations/corrections/autoApply');
  const [found] = checkExhaustedInternalAlerts({ exhaustedInternalAlerts: pile() });

  const payload = payloadFor({ checkKey: found.checkKey, proposedChange: found.proposedChange });
  assert.ok(payload, 'an unreachable correction is a correction that does not exist');
  assert.deepEqual(payload.requestIds, found.evidence.requestIds);
});

test('a payload with no ids is no payload', () => {
  const { payloadFor } = require('../services/operations/corrections/autoApply');
  assert.equal(payloadFor({
    checkKey: 'home_time.exhausted_internal_alerts', proposedChange: { requestIds: [] },
  }), null);
  assert.equal(payloadFor({
    checkKey: 'home_time.exhausted_internal_alerts', proposedChange: {},
  }), null);
});

test('a NEW pile is a new finding, not a permanently applied one', () => {
  // A fixed subject id looked like the right way to keep the pile to one row.
  // It is not: `resolveClearedFindings` only touches `status = 'open'`, so once
  // this finding is applied it stays `applied` forever — and `upsertFinding`
  // preserves every status except `resolved`. A later pile would update that
  // same row with new request ids and never reappear in open findings, so it
  // could never be applied. The same permanent suppression follows a dismissal.
  const first = checkExhaustedInternalAlerts({
    exhaustedInternalAlerts: pile({ count: 2, requestIds: [1, 2] }),
  })[0];
  const second = checkExhaustedInternalAlerts({
    exhaustedInternalAlerts: pile({ count: 3, requestIds: [1, 2, 7] }),
  })[0];

  assert.notEqual(first.subjectId, second.subjectId,
    'a different pile is a different incident and needs its own row');
});

test('the SAME pile keeps one row however often the sweep runs', () => {
  // The dedup that made a fixed subject attractive in the first place, kept:
  // the identity is the pile's contents, so a re-run of the same pile — in any
  // order — collides on the unique constraint rather than accumulating.
  const a = checkExhaustedInternalAlerts({
    exhaustedInternalAlerts: pile({ count: 3, requestIds: [7, 1, 2] }),
  })[0];
  const b = checkExhaustedInternalAlerts({
    exhaustedInternalAlerts: pile({ count: 3, requestIds: [1, 2, 7] }),
  })[0];
  assert.equal(a.subjectId, b.subjectId);
});

test('the subject id still says which queue it is about', () => {
  const [found] = checkExhaustedInternalAlerts({ exhaustedInternalAlerts: pile() });
  assert.match(found.subjectId, /^home_time_internal_alerts:/,
    'an opaque digest alone would be unreadable in the audit trail');
});
