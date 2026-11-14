'use strict';

/**
 * The activity log's pure rules (lib/activityLog/): what a Bitrix write
 * becomes as an entry, what an entry may never hold, and when the owner is
 * told that Bitrix keeps saying no. Names and numbers are made up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const E = require('../lib/activityLog/entry');
const S = require('../lib/activityLog/failureStreak');

test('any *.add|update|delete is a write — not only crm.* — and reads never are', () => {
  for (const m of ['crm.deal.update', 'crm.deal.add', 'crm.contact.add', 'crm.contact.update', 'crm.lead.add',
    'crm.item.update', 'crm.deal.delete', 'crm.timeline.comment.add',
    'tasks.task.add', 'im.notify.system.add', 'user.update', 'disk.folder.delete']) {
    assert.equal(E.isBitrixWrite(m), true, m);
  }
  for (const m of ['crm.deal.get', 'crm.deal.list', 'crm.deal.fields', 'crm.status.list', 'crm.item.list',
    'crm.duplicate.findbycomm', 'user.get', '', null]) {
    assert.equal(E.isBitrixWrite(m), false, String(m));
  }
});

test('the action names what changed', () => {
  assert.equal(E.actionFor('crm.deal.update', { fields: { STAGE_ID: 'C3:W' } }), 'deal.stage');
  assert.equal(E.actionFor('crm.deal.update', { fields: { STAGE_ID: 'C33:X', UF_A: 1 } }), 'deal.stage');
  assert.equal(E.actionFor('crm.deal.update', { fields: { TITLE: 'x' } }), 'deal.title');
  assert.equal(E.actionFor('crm.deal.update', { fields: { UF_CRM_TRUCK: 9 } }), 'deal.fields');
  assert.equal(E.actionFor('crm.deal.add', {}), 'deal.create');
  assert.equal(E.actionFor('crm.contact.add', {}), 'contact.create');
  assert.equal(E.actionFor('crm.contact.update', {}), 'contact.update');
  assert.equal(E.actionFor('crm.lead.add', {}), 'lead.create');
  assert.equal(E.actionFor('crm.item.update', {}), 'item.update');
  assert.equal(E.actionFor('tasks.task.add', {}), 'tasks.task.create');
  assert.equal(E.targetFor('user.update', { ID: 4 }).targetType, 'user');
});

test('a smart-process item\'s answer ({item: {...}}) is a done write, and an add takes its id from it', () => {
  const audit = { actorKind: 'automatic', trigger: 't' };
  const updated = E.bitrixWriteEntry({
    method: 'crm.item.update', params: { entityTypeId: 1040, id: 5, fields: { title: 'X' } }, audit, result: { item: { id: 5, title: 'X' } },
  });
  assert.deepEqual([updated.result, updated.targetType, updated.targetId], ['done', 'item', '5']);
  const added = E.bitrixWriteEntry({
    method: 'crm.item.add', params: { entityTypeId: 1040, fields: { title: 'X' } }, audit, result: { item: { id: 812 } },
  });
  assert.deepEqual([added.result, added.targetId], ['done', '812']);
  assert.equal(E.bitrixWriteEntry({ method: 'crm.item.delete', params: { entityTypeId: 1040, id: 5 }, audit, result: [] }).result, 'done');
  // Still not confirmed: an item update that came back with no item, a classic update not `true`.
  assert.equal(E.bitrixWriteEntry({ method: 'crm.item.update', params: { id: 5 }, audit, result: true }).result, 'failed');
  assert.equal(E.bitrixWriteEntry({ method: 'crm.deal.update', params: { id: 5 }, audit, result: { item: {} } }).result, 'failed');
  // Another namespace: an answer that is not false or empty is done.
  assert.equal(E.bitrixWriteEntry({ method: 'tasks.task.add', params: {}, audit, result: { task: { id: 9 } } }).result, 'done');
  assert.equal(E.bitrixWriteEntry({ method: 'user.update', params: { ID: 4 }, audit, result: false }).result, 'failed');
});

test('a done update, a new record\'s id, and an unconfirmed write', () => {
  const done = E.bitrixWriteEntry({
    method: 'crm.deal.update',
    params: { id: 321, fields: { STAGE_ID: 'C3:H' } },
    audit: { actorKind: 'person_button', actorTelegramId: 777, actorName: 'Ann Lee', trigger: 'board_bitrix.button', reason: 'r' },
    result: true,
  });
  assert.equal(done.result, 'done');
  assert.equal(done.targetType, 'deal');
  assert.equal(done.targetId, '321');
  assert.equal(done.actorTelegramId, 777);
  assert.deepEqual(done.change, [{ field: 'STAGE_ID', from: null, to: 'C3:H' }]);

  const created = E.bitrixWriteEntry({ method: 'crm.contact.add', params: { fields: {} }, audit: { actorKind: 'automatic' }, result: 55 });
  assert.equal(created.targetId, '55');
  assert.equal(created.result, 'done');

  const unconfirmed = E.bitrixWriteEntry({ method: 'crm.deal.update', params: { id: 1, fields: {} }, audit: {}, result: false });
  assert.equal(unconfirmed.result, 'failed');
  assert.match(unconfirmed.error, /did not confirm/);
});

test('Bitrix answering no is refused; no answer is failed; the error loses every URL and number', () => {
  const refused = E.bitrixWriteEntry({
    method: 'crm.deal.update', params: { id: 1 }, audit: {},
    error: Object.assign(new Error('Bitrix crm.deal.update: Access denied https://acme.bitrix24.com/rest/1/s3cr3tc0de/ call +1 (312) 555-0199'), { retryable: false }),
  });
  assert.equal(refused.result, 'refused');
  assert.doesNotMatch(refused.error, /s3cr3t|acme\.bitrix24|555-0199/);
  assert.match(refused.error, /Access denied/);
  const failed = E.bitrixWriteEntry({
    method: 'crm.deal.update', params: { id: 1 }, audit: {}, error: Object.assign(new Error('timeout'), { retryable: true }),
  });
  assert.equal(failed.result, 'failed');
  assert.equal(E.redactError('x'.repeat(900)).length <= E.ERROR_MAX, true);
  assert.equal(E.redactError('webhook rest/12/abcDEF123/crm.deal.update'), 'webhook rest/<redacted>/crm.deal.update');
});

test('a change never shows contact details or free text; a date survives, a phone does not', () => {
  const change = E.changeFromFields({
    NAME: 'Ann', PHONE: [{ VALUE: '+13125550199' }], EMAIL: [{ VALUE: 'a@b.c' }], COMMENTS: 'chat text',
    ORIGIN_ID: 'tg:1:2', UF_HOME_FROM: '2026-11-10', UF_NOTE: 'call 3125550199', UF_OBJ: { a: 1 },
  });
  assert.deepEqual(change.map((c) => c.field), ['NAME', 'UF_HOME_FROM', 'UF_NOTE', 'UF_OBJ']);
  assert.equal(change.find((c) => c.field === 'UF_HOME_FROM').to, '2026-11-10');
  assert.equal(change.find((c) => c.field === 'UF_NOTE').to, 'call [number removed]');
  assert.equal(change.find((c) => c.field === 'UF_OBJ').to, null);
});

test('no audit context is still an entry — unknown, with a reason saying so', () => {
  const e = E.bitrixWriteEntry({ method: 'crm.deal.update', params: { id: 9, fields: { STAGE_ID: 'X' } }, result: true });
  assert.equal(e.actorKind, 'unknown');
  assert.equal(e.reason, E.NO_CONTEXT_REASON);
  assert.equal(E.normalizeAudit({ actorKind: 'boss' }).actorKind, 'unknown');
});

test('evidence keeps ids only', () => {
  const a = E.normalizeAudit({ evidence: { questionId: 4, nested: { x: 1 }, list: [1], ok: true, note: 'see https://x.y/z?token=abc' } });
  assert.deepEqual(a.evidence, { questionId: 4, ok: true, note: 'see <url>' });
  // A chat id or a leadgen id IS the evidence — kept whole.
  assert.deepEqual(E.normalizeAudit({ evidence: { chatId: '-1001234567890', leadgenId: '1234567890123456' } }).evidence,
    { chatId: '-1001234567890', leadgenId: '1234567890123456' });
});

test('an attempt that never reached Bitrix keeps its own result', () => {
  const e = E.attemptEntry({
    action: 'deal.stage', targetId: 321, result: 'refused', error: 'the deal stage changed after the comparison',
    audit: { actorKind: 'automatic', trigger: 'board_bitrix.sync' },
  });
  assert.equal(e.result, 'refused');
  assert.equal(e.targetId, '321');
  assert.equal(e.safetyCheck, true, 'a refused attempt is a safety check of ours unless it says otherwise');
  assert.equal(E.attemptEntry({ action: 'x', result: 'bogus' }).result, 'failed');
  assert.equal(E.attemptEntry({ action: 'x', result: 'already_done' }).safetyCheck, false);
  assert.equal(E.bitrixWriteEntry({ method: 'crm.deal.update', params: { id: 1 }, result: true }).safetyCheck, false);
});

test('an attempt whose read threw: no answer is failed, Bitrix\'s no is refused — never a safety check', () => {
  const timeout = Object.assign(new Error('Bitrix did not answer crm.deal.get in 15000ms'), { retryable: true, reason: 'network_error' });
  assert.deepEqual(E.attemptFromError(timeout), { result: 'failed', error: timeout.message, safetyCheck: false });
  const denied = Object.assign(new Error('Bitrix crm.deal.get: Access denied'), { retryable: false, reason: 'api_error' });
  assert.equal(E.attemptFromError(denied).result, 'refused');
  const e = E.attemptEntry({ action: 'deal.stage', audit: {}, ...E.attemptFromError(denied) });
  assert.deepEqual([e.result, e.safetyCheck], ['refused', false]);
  assert.equal(E.attemptFromError(new Error('database down')).result, 'failed');
});

// ── the owner's notice ──────────────────────────────────────────────────────

const entries = (...results) => results.map((result, i) => ({ id: 100 - i, result }));

test('three failures in a row tell the owner; two do not; a success in between resets', () => {
  assert.equal(S.decideFailureNotice({ entries: entries('failed', 'refused') }).notify, false);
  const three = S.decideFailureNotice({ entries: entries('failed', 'refused', 'failed', 'done') });
  assert.equal(three.notify, true);
  assert.equal(three.streak, 3);
  assert.equal(three.streakStartId, 98);
  assert.equal(S.decideFailureNotice({ entries: entries('failed', 'done', 'failed', 'failed') }).notify, false);
  assert.equal(S.decideFailureNotice({ entries: entries('failed', 'already_done', 'failed', 'failed') }).notify, false);
});

test('the same streak keeps its key; a quiet six hours is respected', () => {
  const four = S.decideFailureNotice({ entries: entries('failed', 'failed', 'failed', 'failed', 'done') });
  assert.equal(four.streakStartId, 97, 'the streak\'s first entry, whatever its length');
  assert.equal(S.decideFailureNotice({ entries: entries('failed', 'failed', 'failed'), toldWithinQuietHours: true }).notify, false);
});

test('a streak longer than the window read is decided on its EXACT start, never assumed told', () => {
  const full = Array.from({ length: S.WINDOW }, (_, i) => ({ id: 500 - i, result: 'failed' }));
  const noStart = S.decideFailureNotice({ entries: full });
  assert.equal(noStart.notify, false, 'without the start there is no key to say it under');
  const found = S.decideFailureNotice({ entries: full, exactStartId: 410 });
  assert.deepEqual([found.notify, found.streakStartId, found.atLeast], [true, 410, true]);
  assert.equal(S.decideFailureNotice({ entries: full, exactStartId: 410, toldThisStreak: true }).notify, false);
  assert.equal(S.decideFailureNotice({ entries: full.slice(0, 5) }).notify, true, 'a short history that is all failures is complete');
  assert.equal(S.decideFailureNotice({ entries: full.slice(0, 5), exactStartId: 1 }).streakStartId, 496, 'a complete streak ignores the lookup');
});

test('a streak held back by the quiet hours that outgrows the window is said once they end', () => {
  // 10:00 streak A told; 10:20 one success; from 10:21 streak B — 20+ failures
  // inside the six hours, every check quiet. After 16:00 the next failure:
  const streakB = Array.from({ length: S.WINDOW }, (_, i) => ({ id: 900 - i, result: 'refused' }));
  const during = S.decideFailureNotice({ entries: streakB, exactStartId: 850, toldWithinQuietHours: true });
  assert.equal(during.notify, false);
  const after = S.decideFailureNotice({ entries: streakB, exactStartId: 850, toldWithinQuietHours: false });
  assert.deepEqual([after.notify, after.streakStartId], [true, 850], 'streak B was never told — it is now');
  // …and once: its key now exists.
  assert.equal(S.decideFailureNotice({ entries: streakB, exactStartId: 850, toldThisStreak: true }).notify, false);
});

test('the notice is plain words with the feature named', () => {
  const t = S.failureNoticeText({ trigger: 'board_bitrix.sync', streak: 3, latest: { result: 'refused', error: 'Access denied' } });
  assert.match(t.title, /3 changes in a row/);
  assert.match(S.failureNoticeText({ trigger: 'x', streak: 20, atLeast: true, latest: {} }).title, /20 or more changes in a row/);
  assert.match(t.lines[0], /automatic status sync/);
  assert.match(t.lines[1], /Access denied/);
  assert.match(t.action, /Monitoring → Logs/);
});
