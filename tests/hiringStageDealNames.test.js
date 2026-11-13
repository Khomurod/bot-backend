'use strict';

/**
 * Hiring deal names, end to end through the REAL reviewer, creation, rename
 * and buttons against the stateful fake Bitrix
 * (tests/helpers/hiringStageCrmHarness.js) — owner, 13–14 November 2026:
 *
 *   - a created deal is titled in Safety's spelling and order, by rules;
 *   - a conversation that already has a deal never creates one, and a closed
 *     one is said once on the card, with no "please create it";
 *   - a rejected candidate with no deal gets nothing created and no request;
 *   - a placeholder deal title is renamed only after a press, only while it
 *     is still the placeholder, never on the Board's pipeline, and a contact
 *     with a real name is never renamed.
 *
 * Names and numbers are made up, apart from the examples the owner quoted.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('./helpers/hiringStageCrmHarness');

const {
  state, run, press, thread, conversation, m, SAFETY,
} = h;

const GOOWIN = 'Company Driver - 99 CPM\nGOOWIN LEAH ANN\n(555) 201-3344';
const KWAME = 'Company Driver - 99 CPM\nKWAME ASANTE\n(555) 201-3344';
const PHONE = '5552013344';
const calls = (method) => state.calls.filter((c) => c === method).length;
const safety = (messageId, text) => m(messageId, {
  fromUserId: SAFETY, fromName: 'Safety', text, replyToMessageId: 169,
});

function start(post = GOOWIN, ...extra) {
  h.reset();
  state.messages = [...conversation(post), ...extra];
}

test('A CREATED DEAL is titled in Safety\'s spelling and order: "Goowin Leah Ann" + "LEAH GOODWIN APPROVED" → "Leah Ann Goodwin"', async () => {
  start(GOOWIN, safety(175, 'LEAH GOODWIN APPROVED'));
  assert.equal(await run(), 'retry');
  assert.equal(state.deals[0].title, 'Leah Ann Goodwin');
  assert.deepEqual([state.contacts[0].first, state.contacts[0].last], ['Leah Ann', 'Goodwin']);
  assert.equal(state.records[0].driverName, 'Goowin Leah Ann', 'the post\'s words, to find by');
  assert.equal(state.records[0].displayName, 'Leah Ann Goodwin', 'the written name, stored at the claim');
  assert.match(state.sent[0].text, /^👤 <b>Goowin Leah Ann<\/b>/, 'the card keeps the post\'s name');
  assert.match(state.sent[0].text, /🆕 Deal created with a new contact — .*Leah Ann Goodwin/);
});

test('no Safety words: the post\'s line as today; a recruiter\'s or the model\'s spelling is never used', async () => {
  start(GOOWIN, m(175, { text: 'Leah Goodwin is on her way', replyToMessageId: 169 }));
  state.aiAnswer = {
    move: true, stage_id: 'UC_SAFETY', driver_name: 'Leah Ann Goowin', evidence: 'CLH sent',
  };
  await run();
  assert.equal(state.deals[0].title, 'Goowin Leah Ann');
  assert.deepEqual([state.contacts[0].first, state.contacts[0].last], ['Goowin Leah', 'Ann']);
});

test('a creation RESUMED after a timeout writes the name it started with', async () => {
  start(GOOWIN, safety(175, 'LEAH GOODWIN APPROVED'));
  state.fail['crm.deal.add'] = 'timeout';
  assert.equal(await run(), 'retry');
  assert.equal(state.records[0].status, 'creating_deal');
  state.messages = conversation(GOOWIN); // Safety's message is gone from the read
  await run(thread({ attempts: 2 }));
  assert.equal(state.deals.length, 1);
  assert.equal(state.deals[0].title, 'Leah Ann Goodwin');
});

test('THE CONVERSATION\'S OWN DEAL IS CLOSED: nothing created, nobody asked to create it, one line on the card', async () => {
  start(KWAME);
  state.contacts.push({ id: 40, first: 'Destin', last: 'Johnes', phones: [PHONE] });
  state.deals.push({
    id: 6533, title: 'Johnes Destin', stageId: 'LOSE', categoryId: '0', contactId: 40, closed: true,
  });
  state.proposals.push({
    id: 1, rootMessageId: 169, kind: 'move', status: 'applied', dealId: 6533, toStageId: 'LOSE',
  });
  assert.equal(await run(), 'done');
  assert.equal(state.finished.at(-1).outcome.result, 'known_deal_closed');
  assert.equal(calls('crm.contact.add') + calls('crm.deal.add'), 0);
  assert.equal(state.proposals.filter((p) => p.kind === 'create_deal').length, 0, 'no "please create the deal"');
  assert.equal(state.sent.length, 1);
  assert.match(state.sent[0].text, /The deal .*Johnes Destin.* is closed \(Lost\) — nothing to create/);
  assert.doesNotMatch(state.sent[0].text, /please create/);

  await run(thread({ revision: 2 }));
  assert.equal(state.sent.length, 1, 'said once');
});

test('the deal the bot created and a person then closed: never created again, never asked for', async () => {
  start(KWAME);
  state.deals.push({
    id: 77, title: 'Kwame Asante', stageId: 'LOSE', categoryId: '0', contactId: 501, closed: true,
  });
  state.records.push({
    id: 1, chatId: h.CHAT, rootMessageId: 169, phone: PHONE, driverName: 'Kwame Asante', status: 'created', dealId: 77, attempts: 1,
  });
  await run();
  assert.equal(state.finished.at(-1).outcome.result, 'known_deal_closed');
  assert.equal(calls('crm.deal.add'), 0);
  assert.equal(state.proposals.length, 0);
});

test('the conversation\'s own OPEN deal, not found by phone or name, is used — never a second one', async () => {
  start(KWAME);
  state.contacts.push({ id: 40, first: 'Grace', last: 'Mensah', phones: ['5550009999'] });
  state.deals.push({
    id: 41, title: 'Facebook Lead', stageId: 'PREPARATION', categoryId: '0', contactId: 40, closed: false,
  });
  state.proposals.push({
    id: 1, rootMessageId: 169, kind: 'move', status: 'stale', dealId: 41, toStageId: 'UC_DRUG',
  });
  await run();
  assert.equal(calls('crm.contact.add') + calls('crm.deal.add'), 0);
  assert.equal(state.finished.at(-1).outcome.result, 'proposed');
  assert.equal(state.proposals.at(-1).dealId, 41);
});

test('REJECTED with no deal — Safety\'s #NotApproved, or a lost stage — nothing created, no request', async () => {
  start(KWAME, safety(175, '#NotApproved Kwame 3 accidents'));
  assert.equal(await run(), 'done');
  assert.equal(state.finished.at(-1).outcome.result, 'rejected_no_deal');
  assert.equal(calls('crm.contact.add') + calls('crm.deal.add'), 0);
  assert.equal(state.records.length, 0);
  assert.equal(state.proposals.length, 0);
  assert.match(state.sent[0].text, /✖ Rejected — no deal created/);

  start('KWAME ASANTE\n(555) 201-3344\n(555) 201-7788'); // not certain either: still no request
  state.aiAnswer = {
    move: true, stage_id: 'LOSE', driver_name: null, evidence: 'CLH sent',
  };
  await run();
  assert.equal(state.finished.at(-1).outcome.result, 'rejected_no_deal');
  assert.equal(state.proposals.length, 0);
  assert.equal(calls('crm.deal.add'), 0);
});

function placeholderDeal({ title = 'No name  ', categoryId = '0', contact = { first: '', last: '' } } = {}) {
  start(GOOWIN, safety(175, 'LEAH GOODWIN APPROVED'));
  state.contacts.push({ id: 40, ...contact, phones: [PHONE] });
  state.deals.push({
    id: 41, title, stageId: 'PREPARATION', categoryId, contactId: 40, closed: false,
  });
}

test('A PLACEHOLDER TITLE is offered for renaming on the card — and nothing is written until a press', async () => {
  placeholderDeal();
  assert.equal(await run(), 'done');
  assert.equal(state.renames.length, 1);
  assert.equal(calls('crm.deal.update') + calls('crm.contact.update'), 0, 'offered, not written');
  const card = state.sent.at(-1);
  assert.match(card.text, /📋 Move to <b>Sent to Safety<\/b>\?[\s\S]*✏️ Name in Bitrix: “No name” → “Leah Ann Goodwin”\?/);
  assert.deepEqual(card.extra.reply_markup.inline_keyboard.map((row) => row.map((b) => b.callback_data)),
    [['hst:ok:1', 'hst:no:1'], ['hst:rn:1', 'hst:rk:1']]);

  await run(thread({ revision: 2 }));
  assert.equal(state.renames.length, 1, 'offered once');

  const out = await press('rn', 1);
  assert.match(out.text, /renamed to Leah Ann Goodwin/);
  assert.equal(state.deals[0].title, 'Leah Ann Goodwin');
  assert.deepEqual([state.contacts[0].first, state.contacts[0].last], ['Leah Ann', 'Goodwin'], 'a placeholder contact too');
  assert.equal(calls('crm.deal.update'), 1);
  assert.equal(calls('crm.contact.update'), 1);
  assert.equal(state.renames[0].status, 'applied');
  assert.equal(state.renames[0].decidedByName, 'Ann');
  const edited = state.edits.at(-1);
  assert.match(edited.text, /✏️ Renamed in Bitrix: “No name” → “Leah Ann Goodwin” \(and its contact\) — Ann/);
  assert.deepEqual(edited.extra.reply_markup.inline_keyboard.map((row) => row.map((b) => b.callback_data)),
    [['hst:ok:1', 'hst:no:1']], 'the Move question stays; the rename buttons go');

  assert.equal((await press('rn', 1, { id: 5, first_name: 'Bo' })).text, 'Already answered.');
  assert.equal(calls('crm.deal.update'), 1);
});

test('renamed meanwhile in Bitrix: the press writes nothing', async () => {
  placeholderDeal();
  await run();
  state.deals[0].title = 'Leah Goodwin';
  const out = await press('rn', 1);
  assert.match(out.text, /Renamed meanwhile — left as is/);
  assert.equal(calls('crm.deal.update') + calls('crm.contact.update'), 0);
  assert.equal(state.deals[0].title, 'Leah Goodwin');
  assert.equal(state.renames[0].status, 'stale');
});

test('a contact with a REAL name is never renamed — only the deal\'s placeholder title is', async () => {
  placeholderDeal({ contact: { first: 'Leah', last: 'Goodwin' } });
  await run();
  await press('rn', 1);
  assert.equal(state.deals[0].title, 'Leah Ann Goodwin');
  assert.equal(calls('crm.contact.update'), 0);
  assert.deepEqual([state.contacts[0].first, state.contacts[0].last], ['Leah', 'Goodwin']);
  assert.equal(state.renames[0].contactRenamed, false);
});

test('"Keep as is" records who decided and takes the buttons away; Bitrix failing gives the claim back', async () => {
  placeholderDeal();
  await run();
  assert.match((await press('rk', 1)).text, /left as it is/);
  assert.equal(state.renames[0].status, 'declined');
  assert.equal(state.renames[0].decidedByName, 'Ann');
  assert.equal(calls('crm.deal.update'), 0);
  assert.match(state.edits.at(-1).text, /✏️ Name left as “No name” — Ann/);

  placeholderDeal();
  await run();
  state.fail['crm.deal.update'] = 'refuse';
  assert.match((await press('rn', 1)).text, /Bitrix did not answer/);
  assert.equal(state.renames[0].status, 'pending');
  await press('rn', 1);
  assert.equal(state.deals[0].title, 'Leah Ann Goodwin');
});

test('NEVER OFFERED on the Board\'s DRIVER RELATION pipeline 3, nor for a real title', async () => {
  placeholderDeal({ categoryId: '3' });
  await run();
  assert.equal(state.renames.length, 0);
  assert.doesNotMatch(state.sent.map((s) => s.text).join('\n'), /Name in Bitrix/);

  placeholderDeal({ title: 'Leah Goodwin' });
  await run();
  assert.equal(state.renames.length, 0);
});
