'use strict';

/**
 * Reading the CDL photo of a lead a person ASKED for — end to end through the
 * REAL reviewer, requested read, creation, CDL step and card, against the
 * stateful fake Bitrix (tests/helpers/hiringStageCrmHarness.js). Only the
 * model's reading is a fake (`state.readCdl`). Owner, 14 November 2026:
 *
 *   - mapped values go to the contact or deal, ONE update per record, never
 *     over a filled field; the rest in ONE timeline comment;
 *   - the CDL's name must be the post's; a mismatch writes nothing; a post
 *     naming nobody may take the CDL's name to create the candidate;
 *   - unsure, switched off, no provider chosen, no photo: nothing is written,
 *     and the card says why;
 *   - the values are never in Wenze's rows, the card or the log's `change`.
 *
 * Every name and number is made up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('./helpers/hiringStageCrmHarness');

const { state, thread, m } = h;
const { processThread } = require('../services/hiringStages/reviewer');

const KWAME = 'Company Driver - 99 CPM\nKWAME ASANTE\n(555) 201-3344';
const NO_NAME = 'Company Driver - 99 CPM\n(555) 201-3344';
const PHOTOS = [{ file_id: 'cdl-front', file_size: 1000 }, { file_id: 'cdl-back', file_size: 1000 }];
const post = (text = KWAME, over = {}) => m(169, { photos: PHOTOS, text, ...over });
const tag = (messageId = 175) => m(messageId, {
  fromUserId: '4242', fromName: 'Ann Lee', text: '@Wenze_Bot', replyToMessageId: 169, botRequest: true,
});
const requested = (over = {}) => thread({
  requestedAt: '2026-11-14T10:00:00Z', requestedByUserId: '4242', requestedByName: 'Ann Lee', requestMessageId: 175, ...over,
});
const run = (t = requested()) => processThread(t, { settings: h.SETTINGS, telegram: h.telegram, readStage: h.readStage });
const allCardText = () => state.sent.map((s) => s.text).concat(state.edits.map((e) => e.text)).join('\n');

const VALUES = {
  first_name: 'Kwame', last_name: 'Asante', date_of_birth: '1988-04-12', license_number: 'A1234567',
  license_state: 'TX', license_class: 'A', expiration_date: '2030-04-12', eye_color: 'BRO',
};
const SECRETS = ['1988-04-12', 'A1234567', '2030-04-12'];
const reading = (values = VALUES, over = {}) => async () => ({
  status: 'read', values, front: 1, back: 2, providerKey: 'anthropic', model: 'claude-sonnet-5-5', providerLabel: 'Claude', ...over,
});

function start(postMessage = post(), readCdl = reading()) {
  h.reset();
  state.aiAnswer = { move: false, reason: 'nothing yet' };
  state.messages = [postMessage, tag()];
  state.readCdl = readCdl;
  state.cdlDefs = {
    contact: { BIRTHDATE: { type: 'date' }, UF_CRM_CDL_NO: { type: 'string' }, NAME: { type: 'string' } },
    deal: { UF_CRM_CLASS: { type: 'enumeration', items: [{ ID: '71', VALUE: 'A' }] }, UF_CRM_EXP: { type: 'date' } },
  };
  state.cdlMap = [
    { item: 'date_of_birth', entity: 'contact', fieldCode: 'BIRTHDATE' },
    { item: 'license_number', entity: 'contact', fieldCode: 'UF_CRM_CDL_NO' },
    { item: 'license_class', entity: 'deal', fieldCode: 'UF_CRM_CLASS' },
    { item: 'expiration_date', entity: 'deal', fieldCode: 'UF_CRM_EXP' },
  ];
}

/** No CDL value in anything Wenze keeps or shows. */
function assertNoValueKept() {
  const kept = JSON.stringify([state.sent, state.edits, state.notices, state.cdlReads, state.finished, state.retried,
    state.records, state.proposals, state.reactions, state.audits.map((a) => ({ ...a, method: undefined }))]);
  for (const secret of SECRETS) assert.ok(!kept.includes(secret), `${secret} must not be kept or shown`);
}

test('A TAG on a lead with a CDL: deal created, mapped values written ONCE per record, the rest in ONE comment', async () => {
  start();
  assert.equal(await run(), 'retry', 'the creation is read again in two minutes');
  const [contact] = state.contacts;
  const [deal] = state.deals;
  assert.deepEqual(contact.fields, { BIRTHDATE: '1988-04-12', UF_CRM_CDL_NO: 'A1234567' });
  assert.deepEqual(deal.fields, { UF_CRM_CLASS: '71', UF_CRM_EXP: '2030-04-12' });
  assert.equal(state.calls.filter((c) => c === 'crm.contact.update').length, 1, 'one update for the contact');
  assert.equal(state.calls.filter((c) => c === 'crm.deal.update').length, 1, 'one update for the deal');
  assert.equal(state.comments.length, 1, 'one comment');
  assert.equal(state.comments[0].ENTITY_TYPE, 'deal');
  assert.equal(state.comments[0].ENTITY_ID, deal.id);
  assert.match(state.comments[0].COMMENT, /^CDL \(read by anthropic\/claude-sonnet-5-5\)\nFront: photo 1, back: photo 2/);
  assert.match(state.comments[0].COMMENT, /Issuing state: TX\nEye colour: BRO/);
  assert.match(state.comments[0].COMMENT, /First name: Kwame/, 'the name items were unmapped: in the comment');

  assert.match(allCardText(), /🪪 CDL read \(Claude\): 4 items written to Bitrix, 4 in a comment/);
  assert.deepEqual(state.cdlReads.map((r) => [r.status, r.itemsWritten, r.itemsInComment, r.providerKey]),
    [['written', 4, 4, 'anthropic']]);
  assert.deepEqual(state.cdlReads[0].writtenItems.sort(), ['date_of_birth', 'expiration_date', 'license_class', 'license_number']);

  // Recorded as the person who asked, the field names only.
  const cdl = state.audits.filter((a) => a.trigger === 'hiring_stage.cdl');
  assert.deepEqual(cdl.map((a) => a.method), ['crm.contact.update', 'crm.deal.update', 'crm.timeline.comment.add']);
  for (const a of cdl) {
    assert.deepEqual([a.actorKind, a.actorTelegramId, a.actorName, a.valuesWithheld], ['person_reply', '4242', 'Ann Lee', true]);
    assert.equal(a.evidence.requestMessageId, 175);
  }
  assert.deepEqual(cdl[0].change, [
    { field: 'BIRTHDATE', from: null, to: 'set (from CDL)' }, { field: 'UF_CRM_CDL_NO', from: null, to: 'set (from CDL)' },
  ]);
  assertNoValueKept();

  // The read two minutes later — and every later read of this tag — reads no CDL again.
  assert.equal(state.cdlAsked, 1);
  await run(requested({ revision: 2 }));
  await run(requested({ revision: 3, requestMessageId: 181 }));
  assert.equal(state.cdlAsked, 1, 'a written CDL is never read again, even on a new tag');
  assert.equal(state.comments.length, 1);
});

test('THE CDL NAME DIFFERS from the post: nothing from the CDL is written; the deal is created anyway', async () => {
  start(post(), reading({ ...VALUES, first_name: 'Kofi', last_name: 'Mensah' }));
  await run();
  assert.equal(state.deals.length, 1);
  assert.equal(state.deals[0].title, 'Kwame Asante');
  assert.equal(state.deals[0].fields, undefined);
  assert.equal(state.contacts[0].fields, undefined);
  assert.equal(state.comments.length, 0);
  assert.match(allCardText(), /🪪 The CDL name differs from the post — nothing from the CDL was written/);
  assert.equal(state.cdlReads[0].status, 'name_differs');
});

test('one letter off in a long name is the same person', async () => {
  start(post('Company Driver\nKWAME ASANTEE\n(555) 201-3344'));
  await run();
  assert.equal(state.cdlReads[0].status, 'written');
});

test('A POST NAMING NOBODY: the CDL\'s name creates the candidate, and the card says so', async () => {
  start(post(NO_NAME), reading({ ...VALUES, middle_name: 'Kojo' }));
  assert.equal(await run(), 'retry');
  assert.equal(state.deals.length, 1);
  assert.equal(state.deals[0].title, 'Kwame Kojo Asante');
  assert.deepEqual([state.contacts[0].first, state.contacts[0].last], ['Kwame Kojo', 'Asante']);
  assert.match(allCardText(), /4 items written to Bitrix, \d+ in a comment — name read from the CDL/);
  assert.equal(state.cdlReads[0].nameFromCdl, true);
  assert.match(state.audits.find((a) => a.method === 'crm.deal.add').trigger, /hiring_stage.create/);
  // Read again: the post still names nobody, the deal is found by phone, nothing is read twice.
  await run(requested({ revision: 2 }));
  assert.equal(state.cdlAsked, 1);
  assert.equal(state.deals.length, 1);
});

test('A FILLED FIELD IS NEVER OVERWRITTEN: an existing candidate found by phone keeps its values', async () => {
  start();
  state.contacts.push({ id: 41, first: 'Kwame', last: 'Asante', phones: ['5552013344'], fields: { BIRTHDATE: '1987-01-01' } });
  state.deals.push({ id: 61, title: 'Kwame Asante', stageId: 'PREPARATION', categoryId: '0', contactId: 41, closed: false, fields: { UF_CRM_EXP: '2030-04-12' } });
  await run();
  assert.equal(state.contacts[0].fields.BIRTHDATE, '1987-01-01', 'not overwritten');
  assert.equal(state.contacts[0].fields.UF_CRM_CDL_NO, 'A1234567');
  assert.deepEqual(state.deals[0].fields, { UF_CRM_EXP: '2030-04-12', UF_CRM_CLASS: '71' });
  assert.match(state.comments[0].COMMENT, /Date of birth: 1988-04-12 \(Bitrix already had another value — not changed\)/);
  assert.doesNotMatch(state.comments[0].COMMENT, /Expiration date/, 'the same value is left alone');
  assert.match(allCardText(), /2 items written to Bitrix, 5 in a comment/);
});

for (const [why, readCdl, line, status] of [
  ['UNSURE', async () => ({ status: 'unsure', providerKey: 'gemini', model: 'g', providerLabel: 'Gemini' }), /CDL not written: Gemini was not sure/, 'unsure'],
  ['SWITCHED OFF', async () => ({ status: 'off' }), /CDL not read: reading CDL photos is switched off/, 'off'],
  ['NO PROVIDER CHOSEN', async () => ({ status: 'no_provider' }), /no AI provider is chosen for it/, 'no_provider'],
  ['UNREADABLE', async () => ({ status: 'unreadable' }), /could not be read/, 'unreadable'],
]) {
  test(`${why}: nothing from the CDL is written, the deal still is, and the card says why`, async () => {
    start(post(), readCdl);
    await run();
    assert.equal(state.deals.length, 1);
    assert.equal(state.deals[0].fields, undefined);
    assert.equal(state.contacts[0].fields, undefined);
    assert.equal(state.comments.length, 0);
    assert.equal(state.audits.filter((a) => a.trigger === 'hiring_stage.cdl').length, 0);
    assert.match(allCardText(), line);
    assert.equal(state.cdlReads[0].status, status);
  });
}

test('switched off, then on: the same tag is not read again — a NEW tag is', async () => {
  start(post(), async () => ({ status: 'off' }));
  await run();
  state.readCdl = reading();
  await run(requested({ revision: 2 }));
  assert.equal(state.comments.length, 0, 'the same tag had its read');
  state.messages.push(tag(181));
  await run(requested({ revision: 3, requestMessageId: 181 }));
  assert.equal(state.cdlReads.at(-1).status, 'written');
  assert.equal(state.comments.length, 1);
});

test('NO PHOTO: the CDL is not read at all; a team post is not read either', async () => {
  start(post(KWAME, { photos: [] }));
  await run();
  assert.equal(state.cdlAsked, 0);
  assert.match(allCardText(), /CDL not read: the post has no photo/);

  start(post('Team drivers\nKWAME ASANTE\nLEAH GOODWIN\n(555) 201-3344'));
  await run();
  assert.equal(state.cdlAsked, 0);
});

test('BITRIX REFUSES the update: it stops there, the card says so, and its words are not kept', async () => {
  start();
  state.fail['crm.contact.update'] = 'refuse';
  assert.equal(await run(), 'retry', 'the deal was created all the same');
  assert.equal(state.comments.length, 0);
  assert.equal(state.calls.filter((c) => c === 'crm.deal.update').length, 0);
  assert.match(allCardText(), /CDL read \(Claude\), but Bitrix refused or did not answer — 0 items written before that/);
  assert.equal(state.cdlReads[0].status, 'bitrix_refused');
  assertNoValueKept();
});

test('NOTHING MAPPED: every value goes into the one comment', async () => {
  start();
  state.cdlMap = [];
  await run();
  assert.equal(state.calls.filter((c) => /\.update$/.test(c)).length, 0);
  assert.equal(state.calls.filter((c) => /\.fields$/.test(c)).length, 0, 'no field list is needed');
  assert.equal(state.comments[0].COMMENT.split('\n').length, 2 + Object.keys(VALUES).length);
  assert.match(allCardText(), /0 items written to Bitrix, 8 in a comment/);
});
