'use strict';

/**
 * services/hiringStages/cdlBitrix.js through the REAL Bitrix client and the
 * REAL activity-log recorder (only `fetch`, the Bitrix settings and the log's
 * insert are fakes): every CDL write is recorded with field NAMES and never a
 * CDL value — not in `change`, and not in the error when Bitrix refuses
 * (its words may quote the value). The field lists are read-only calls and are
 * not recorded. Every value here is made up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
function stub(rel, exports) {
  const filename = require.resolve(path.resolve(ROOT, rel));
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const logged = [];
stub('database/activityLog.js', { insertEntry: async (e) => { logged.push(e); return { id: logged.length }; } });
stub('services/activityLog/failureNotice.js', { checkFailureStreak: async () => null });
stub('database/bitrix.js', {
  getBitrixConfig: async () => ({ enabled: true, webhookUrl: 'https://acme.bitrix24.com/rest/1/s3cret/' }),
});

const cdlBitrix = require('../services/hiringStages/cdlBitrix');
const { maskedChange, maskedCommentChange } = require('../lib/hiringStages/cdlWrite');

const SECRET_VALUES = ['1988-04-12', 'A1234567', '1200 MAIN ST'];
const calls = [];
function fetchAnswering(answer) {
  return async (url, init) => {
    calls.push({ method: url.split('/').pop().replace('.json', ''), body: JSON.parse(init.body) });
    const { status = 200, body } = typeof answer === 'function' ? answer(url) : answer;
    return { ok: status < 400, status, json: async () => body };
  };
}
const audit = (change) => ({
  actorKind: 'person_reply', actorTelegramId: 4242, actorName: 'Ann Lee', trigger: 'hiring_stage.cdl',
  reason: 'A person asked for this lead; the CDL was read.', evidence: { chatId: '-100', rootMessageId: 169, dealId: 9 },
  targetLabel: 'Kwame Asante', change, valuesWithheld: true,
});
const noValueIn = (entry) => {
  const text = JSON.stringify(entry);
  for (const value of SECRET_VALUES) assert.ok(!text.includes(value), `${value} must not be in the log`);
};

test('ONE update per record: the fields go to Bitrix, the log keeps their names only', async () => {
  logged.length = 0;
  calls.length = 0;
  const fields = { BIRTHDATE: '1988-04-12', UF_CRM_CDL_NO: 'A1234567', ADDRESS: '1200 MAIN ST' };
  await cdlBitrix.updateRecordFields('contact', 7, fields, {
    fetchImpl: fetchAnswering({ body: { result: true } }), audit: audit(maskedChange(Object.keys(fields))),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'crm.contact.update');
  assert.deepEqual(calls[0].body.fields, fields, 'the values reach Bitrix');
  assert.equal(logged.length, 1);
  const [e] = logged;
  assert.deepEqual([e.action, e.result, e.trigger, e.actorKind, e.targetId], ['contact.update', 'done', 'hiring_stage.cdl', 'person_reply', '7']);
  assert.deepEqual(e.change, [
    { field: 'BIRTHDATE', from: null, to: 'set (from CDL)' }, { field: 'UF_CRM_CDL_NO', from: null, to: 'set (from CDL)' },
  ], 'ADDRESS is never shown, and no value is');
  noValueIn(e);
});

test('a REFUSAL quoting the value keeps none of Bitrix\'s words', async () => {
  logged.length = 0;
  await assert.rejects(cdlBitrix.updateRecordFields('deal', 9, { UF_CRM_CDL_NO: 'A1234567' }, {
    fetchImpl: fetchAnswering({ status: 400, body: { error: 'ERROR', error_description: 'Value "A1234567" is not valid' } }),
    audit: audit(maskedChange(['UF_CRM_CDL_NO'])),
  }), (err) => err.name === 'BitrixError');
  const [e] = logged;
  assert.equal(e.result, 'refused');
  assert.match(e.error, /Its words are not kept/);
  noValueIn(e);
});

test('even a caller that forgot its mask gets none of the values logged', async () => {
  logged.length = 0;
  const { change, ...withoutChange } = audit();
  await cdlBitrix.updateRecordFields('deal', 9, { UF_CRM_CDL_NO: 'A1234567' }, {
    fetchImpl: fetchAnswering({ body: { result: true } }), audit: withoutChange,
  });
  assert.deepEqual(logged[0].change, [{ field: 'UF_CRM_CDL_NO', from: null, to: '(not shown)' }]);
  noValueIn(logged[0]);
});

test('the ONE timeline comment: on the deal, recorded with the item names only', async () => {
  logged.length = 0;
  calls.length = 0;
  const id = await cdlBitrix.addDealComment(9, 'CDL (read by anthropic/claude)\nLicence number: A1234567', {
    fetchImpl: fetchAnswering({ body: { result: 555 } }), audit: audit(maskedCommentChange(['license_number'])),
  });
  assert.equal(id, 555);
  assert.equal(calls[0].method, 'crm.timeline.comment.add');
  assert.deepEqual([calls[0].body.fields.ENTITY_TYPE, calls[0].body.fields.ENTITY_ID], ['deal', 9]);
  const [e] = logged;
  assert.deepEqual([e.action, e.result], ['timeline.comment.create', 'done']);
  assert.deepEqual(e.change, [{ field: 'cdl:license_number', from: null, to: 'in the comment (from CDL)' }]);
  noValueIn(e);
});

test('an update Bitrix does not confirm throws, and is recorded as failed', async () => {
  logged.length = 0;
  await assert.rejects(cdlBitrix.updateRecordFields('contact', 7, { UF_CRM_X: 'A1234567' }, {
    fetchImpl: fetchAnswering({ body: { result: false } }), audit: audit(maskedChange(['UF_CRM_X'])),
  }), /did not confirm/);
  assert.equal(logged[0].result, 'failed');
});

test('the field lists are READ ONLY: two calls, nothing recorded', async () => {
  logged.length = 0;
  calls.length = 0;
  const lists = await cdlBitrix.readFieldLists({
    fetchImpl: fetchAnswering((url) => ({ body: { result: url.includes('contact') ? { NAME: {} } : { TITLE: {} } } })),
  });
  assert.deepEqual(lists, { contact: { NAME: {} }, deal: { TITLE: {} } });
  assert.deepEqual(calls.map((c) => c.method).sort(), ['crm.contact.fields', 'crm.deal.fields']);
  assert.equal(logged.length, 0);
});
