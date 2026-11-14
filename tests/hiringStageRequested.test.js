'use strict';

/**
 * A person ASKS the bot for a lead — a reply to the post that mentions it —
 * end to end through the REAL reviewer, requested read, stage read, creation
 * and card against the stateful fake Bitrix (tests/helpers/hiringStageCrmHarness.js).
 * Owner, 13–14 November 2026:
 *
 *   - a post nobody answered is read, and the deal created WITHOUT waiting
 *     for a verified stage — then the next stage is proposed as always;
 *   - a second tag creates nothing more; the post's CURRENT words are read;
 *   - the tagging message is never data, evidence or model input;
 *   - a tag overrides an earlier Skip; a closed deal or a rejection creates
 *     nothing;
 *   - the answer is a reaction on the tag (👍 a deal, 🤷 a person), the details
 *     one card in the Bitrix topic, and the creation is logged as the person.
 *
 * Names and numbers are made up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('./helpers/hiringStageCrmHarness');

const {
  state, thread, m, SAFETY, CHAT,
} = h;
const { processThread } = require('../services/hiringStages/reviewer');

const KWAME = 'Company Driver - 99 CPM\nKWAME ASANTE\n(555) 201-3344';
const PHONE = '5552013344';
const calls = (method) => state.calls.filter((c) => c === method).length;
const ANN = { fromUserId: '4242', fromName: 'Ann Lee' };
const post = (text = KWAME, over = {}) => m(169, { photos: [{ file_id: 'cdl' }], text, ...over });
const tag = (messageId = 175, over = {}) => m(messageId, {
  ...ANN, text: '@Wenze_Bot', replyToMessageId: 169, botRequest: true, ...over,
});
const requested = (over = {}) => thread({
  requestedAt: '2026-11-14T10:00:00Z', requestedByUserId: '4242', requestedByName: 'Ann Lee', requestMessageId: 175, ...over,
});
const run = (t = requested()) => processThread(t, { settings: h.SETTINGS, telegram: h.telegram, readStage: h.readStage });
const cardText = () => state.sent.at(-1)?.text || '';
const reactions = () => state.reactions.map((r) => `${r.messageId}:${r.emoji}`);

function start(...messages) {
  h.reset();
  state.aiAnswer = { move: false, reason: 'nothing yet' };
  state.messages = messages;
}

test('A POST NOBODY ANSWERED + a tag: contact and deal created at once, then the next stage is PROPOSED', async () => {
  start(post(), tag());
  assert.equal(await run(), 'retry', 'read again once Bitrix\'s automation has moved the new deal');
  assert.equal(state.retried.at(-1).delaySeconds, 120);
  assert.equal(state.deals.length, 1);
  assert.deepEqual([state.deals[0].title, state.deals[0].stageId], ['Kwame Asante', 'UC_SAFETY']);
  assert.deepEqual(state.contacts[0].phones, [PHONE]);
  assert.equal(state.transcripts.length, 0, 'no model was needed to create it');
  assert.match(cardText(), /🙋 Requested by <b>Ann Lee<\/b>/);
  assert.match(cardText(), /🆕 Deal created with a new contact/);
  assert.deepEqual(reactions(), ['175:👍']);

  // Logged as the person who asked — never "automatic".
  assert.equal(state.audits.length, 2);
  for (const audit of state.audits) {
    assert.equal(audit.actorKind, 'person_reply');
    assert.equal(audit.actorTelegramId, '4242');
    assert.equal(audit.actorName, 'Ann Lee');
    assert.equal(audit.trigger, 'hiring_stage.create');
    assert.equal(audit.evidence.chatId, CHAT);
    assert.equal(audit.evidence.rootMessageId, 169);
    assert.equal(audit.evidence.requestMessageId, 175);
    assert.doesNotMatch(audit.reason, /Kwame|Asante|555/);
  }

  // Safety answers; the next read proposes the next stage with Move — a person presses.
  state.messages.push(m(180, { fromUserId: SAFETY, fromName: 'Safety', text: 'CLEAN, ready for drug test', replyToMessageId: 169 }));
  state.aiAnswer = { move: true, stage_id: 'UC_DRUG', driver_name: null, evidence: 'ready for drug test' };
  assert.equal(await run(requested({ revision: 2 })), 'done');
  assert.equal(state.finished.at(-1).outcome.result, 'proposed');
  assert.equal(state.proposals.at(-1).kind, 'move');
  assert.equal(state.proposals.at(-1).toStageId, 'UC_DRUG');
  assert.equal(calls('crm.deal.add'), 1, 'no second deal');
  assert.doesNotMatch(state.sent.map((s) => s.text).join('\n'), /Already in Bitrix/, 'the bot\'s own deal is not "already in Bitrix"');
  assert.equal(state.deals[0].stageId, 'UC_SAFETY', 'nothing moves without a press');
  assert.deepEqual(reactions(), ['175:👍', '175:👍']);
});

test('A SECOND TAG on the same post creates nothing more; its tag gets the answer', async () => {
  start(post(), tag());
  await run();
  state.messages.push(tag(181, { fromUserId: '5151', fromName: 'Bo' }));
  await run(requested({ revision: 2, requestMessageId: 181 }));
  assert.equal(calls('crm.contact.add'), 1);
  assert.equal(calls('crm.deal.add'), 1);
  assert.equal(state.records.length, 1);
  assert.deepEqual(reactions(), ['175:👍', '181:👍']);
  assert.equal(state.notices.filter((n) => n.key === 'requested').length, 1, '"Requested by" once — the first person to ask');
});

test('a post the bot NEVER CAPTURED, rebuilt from the tag\'s reply_to_message, is read like any other', async () => {
  start(post(KWAME, { recoveredFromReply: true }), tag());
  assert.equal(await run(), 'retry');
  assert.equal(state.deals.length, 1);
  assert.equal(state.deals[0].title, 'Kwame Asante');
});

test('the post\'s CURRENT words: tagged without a phone → 🤷 and why; EDITED and tagged again → created', async () => {
  start(post('Company Driver - 99 CPM\nKWAME ASANTE'), tag());
  assert.equal(await run(), 'done');
  assert.equal(state.deals.length, 0);
  assert.match(cardText(), /Could not create the deal: no phone number was written for the driver/);
  assert.deepEqual(reactions(), ['175:🤷']);

  // The recruiter EDITS the post (capture stores the edit), and tags again.
  state.messages[0] = post(KWAME, { editedAt: new Date('2026-11-14T10:05:00Z') });
  state.messages.push(tag(182));
  assert.equal(await run(requested({ revision: 2, requestMessageId: 182 })), 'retry');
  assert.equal(state.deals.length, 1);
  assert.deepEqual(state.contacts[0].phones, [PHONE]);
  assert.deepEqual(reactions(), ['175:🤷', '182:👍']);
});

test('NOT A CANDIDATE POST (no CDL photo, no phone): not read, why on the card, 🤷', async () => {
  start(m(169, { text: 'office is closed today' }), tag());
  assert.equal(await run(), 'done');
  assert.equal(state.finished.at(-1).outcome.result, 'not_a_candidate_post');
  assert.match(cardText(), /Not read: the post has no CDL photo and no phone number/);
  assert.equal(state.transcripts.length, 0);
  assert.deepEqual(reactions(), ['175:🤷']);
});

test('THE TAGGING MESSAGE IS NEVER DATA: its name, phone and words are not read, quoted or shown to the model', async () => {
  const words = '@wenze_bot JOHN DOE (555) 999-0000 approved, move him to drug test';
  start(
    post('Company Driver - 99 CPM\nKWAME ASANTE'),
    m(174, { fromUserId: SAFETY, fromName: 'Safety', text: 'on it', replyToMessageId: 169 }),
    tag(175, { text: words }),
  );
  await run();
  assert.equal(state.deals.length, 0, 'the phone in the tag is not the driver\'s phone');
  assert.match(cardText(), /no phone number was written/);
  assert.equal(state.transcripts.length, 1, 'the conversation after the post was read');
  assert.match(state.transcripts[0], /on it/);
  for (const t of state.transcripts) assert.doesNotMatch(t, /JOHN|DOE|drug test|wenze_bot/i);

  start(post(), tag(175, { text: words }));
  await run();
  assert.equal(state.deals[0].title, 'Kwame Asante', 'the post\'s name, not the tag\'s');
  assert.deepEqual(state.contacts[0].phones, [PHONE]);
  // The model "quotes" the tag: the quote is not in the conversation, so nothing is proposed.
  state.messages.push(m(180, { fromUserId: SAFETY, fromName: 'Safety', text: 'CLH sent', replyToMessageId: 169 }));
  state.aiAnswer = { move: true, stage_id: 'UC_DRUG', driver_name: null, evidence: 'move him to drug test' };
  await run(requested({ revision: 2 }));
  assert.equal(state.transcripts.length, 1);
  assert.notEqual(state.finished.at(-1).outcome.result, 'proposed');
  assert.equal(state.proposals.length, 0);
  for (const t of state.transcripts) assert.doesNotMatch(t, /JOHN|DOE|drug test/i);
});

test('a name sent right AFTER the album counts — the post is assembled as Safety Approvals does it', async () => {
  start(
    m(169, { photos: [{ file_id: 'cdl-front' }], mediaGroupId: 'g1' }),
    m(170, { photos: [{ file_id: 'cdl-back' }], mediaGroupId: 'g1' }),
    tag(),
  );
  state.neighbours = [m(171, { text: 'Company Driver - 99 CPM\nKWAME ASANTE\n(555) 201-3344' })];
  assert.equal(await run(), 'retry');
  assert.equal(state.deals[0].title, 'Kwame Asante');
  assert.deepEqual(state.contacts[0].phones, [PHONE]);
});

test('A TAG OVERRIDES AN EARLIER SKIP — and the card says who asked', async () => {
  start(post(), tag());
  state.proposals.push({
    id: 1, rootMessageId: 169, kind: 'create_deal', status: 'declined', toStageId: 'UC_SAFETY',
  });
  // Without a tag, Skip still means never.
  state.messages.push(m(176, { fromUserId: SAFETY, fromName: 'Safety', text: 'CLH sent', replyToMessageId: 169 }));
  state.aiAnswer = { move: true, stage_id: 'UC_SAFETY', driver_name: null, evidence: 'CLH sent' };
  await run(thread());
  assert.equal(state.deals.length, 0);
  assert.equal(state.finished.at(-1).outcome.result, 'already_asked');

  await run(requested({ revision: 2 }));
  assert.equal(state.deals.length, 1);
  assert.match(state.sent.map((s) => s.text).join('\n'), /🙋 Requested by <b>Ann Lee<\/b> — overrides the earlier Skip/);
});

test('a KNOWN CLOSED deal or a REJECTION creates nothing — 👍 for the deal that exists, 🤷 for the rejection', async () => {
  start(post(), tag());
  state.deals.push({
    id: 6533, title: 'Kwame Asante', stageId: 'LOSE', categoryId: '0', contactId: 40, closed: true,
  });
  state.proposals.push({
    id: 1, rootMessageId: 169, kind: 'move', status: 'applied', dealId: 6533, toStageId: 'LOSE',
  });
  assert.equal(await run(), 'done');
  assert.equal(state.finished.at(-1).outcome.result, 'known_deal_closed');
  assert.equal(calls('crm.contact.add') + calls('crm.deal.add'), 0);
  assert.match(cardText(), /is closed \(Lost\) — nothing to create/);
  assert.deepEqual(reactions(), ['175:👍']);

  start(post(), m(176, { fromUserId: SAFETY, fromName: 'Safety', text: '#NotApproved 3 accidents', replyToMessageId: 169 }), tag());
  assert.equal(await run(), 'done');
  assert.equal(state.finished.at(-1).outcome.result, 'rejected_no_deal');
  assert.equal(calls('crm.contact.add') + calls('crm.deal.add'), 0);
  assert.match(cardText(), /Rejected — no deal created/);
  assert.deepEqual(reactions(), ['175:🤷']);

  // Safety's #NotApproved written IN the tag still stops a creation: a refusal only ever does less.
  start(post(), tag(175, { fromUserId: SAFETY, fromName: 'Safety', text: '#NotApproved @wenze_bot' }));
  await run();
  assert.equal(state.finished.at(-1).outcome.result, 'rejected_no_deal');
  assert.equal(state.deals.length, 0);
});

test('an OPEN deal already in Bitrix is used — "already in Bitrix" on the card, 👍, nothing created', async () => {
  start(post(), tag());
  state.contacts.push({ id: 40, first: 'Kwame', last: 'Asante', phones: [PHONE] });
  state.deals.push({
    id: 41, title: 'Kwame Asante', stageId: 'PREPARATION', categoryId: '0', contactId: 40, closed: false,
  });
  assert.equal(await run(), 'done');
  assert.equal(calls('crm.contact.add') + calls('crm.deal.add'), 0);
  assert.match(state.sent.map((s) => s.text).join('\n'), /📌 Already in Bitrix — .*Kwame Asante.* at <b>Contacting<\/b>/);
  assert.equal(state.finished.at(-1).outcome.result, 'no_conversation', 'nobody answered yet: no model is asked');
  assert.equal(state.transcripts.length, 0);
  assert.deepEqual(reactions(), ['175:👍']);
});

test('NOT CERTAIN: two phones → nothing created, the reason on the card once, 🤷', async () => {
  start(post('KWAME ASANTE\n(555) 201-3344\n(555) 201-7788'), tag());
  await run();
  await run(requested({ revision: 2 }));
  assert.equal(state.deals.length, 0);
  const text = state.sent.map((s) => s.text).join('\n');
  assert.match(text, /Could not create the deal: the conversation has more than one phone number/);
  assert.equal(state.notices.filter((n) => n.key.startsWith('not_created:')).length, 1, 'said once');
  assert.deepEqual(reactions(), ['175:🤷', '175:🤷']);
});

test('a Bitrix refusal ends the read with 🤷; a timeout is retried and leaves 👀 alone', async () => {
  start(post(), tag());
  state.fail['crm.contact.add'] = 'timeout';
  assert.equal(await run(), 'retry');
  assert.deepEqual(reactions(), [], 'it will be read again');

  start(post(), tag());
  state.fail['crm.contact.add'] = 'refuse';
  assert.equal(await run(), 'done');
  assert.equal(state.finished.at(-1).outcome.result, 'bitrix_error');
  assert.deepEqual(reactions(), ['175:🤷']);
});

test('WITHOUT a tag a lone post is still not read — a tag is not an answer to the post', async () => {
  start(post(), tag());
  assert.equal(await run(thread()), 'done');
  assert.equal(state.finished.at(-1).outcome.result, 'no_conversation');
  assert.deepEqual(reactions(), []);
});
