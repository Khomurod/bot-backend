'use strict';

/**
 * A missing Bitrix contact + deal, created by the bot — end to end through the
 * REAL reviewer, deal finder and services/hiringStages/crmCreate.js against a
 * stateful fake Bitrix (tests/helpers/hiringStageCrmHarness.js).
 *
 * Pinned: a CERTAIN candidate with no open deal gets one contact and one deal
 * — never two, whatever is retried, timed out or posted twice; an existing
 * contact is reused; an existing deal is simply used; anything ambiguous or
 * missing creates nothing and asks a person, with the reason; every message
 * goes to the Bitrix topic; nothing is moved without a press. Names and
 * numbers are made up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('./helpers/hiringStageCrmHarness');

const { state, run, thread, conversation, ORIGINATOR } = h;

const CARD = 'Company Driver - 99 CPM\n\nKWAME ASANTE\n(555) 201-3344\n9+ yrs of exp\n\nMatthew\'s referral';
const PHONE = '5552013344';
const adds = (method) => state.calls.filter((c) => c === method).length;
const onlyInTopic = () => state.sent.every((s) => s.extra.message_thread_id === 77 && !s.extra.reply_to_message_id);

function start(post = CARD) {
  h.reset();
  state.messages = conversation(post);
}

test('NEITHER CONTACT NOR DEAL: one contact, one deal at the first stage, said in the topic, then Move?', async () => {
  start();
  assert.equal(await run(), 'done');
  assert.equal(state.contacts.length, 1);
  assert.deepEqual(state.contacts[0], {
    id: 501, first: 'Kwame', last: 'Asante', phones: [PHONE], originId: `tg:${h.CHAT}:169`,
  });
  assert.equal(state.deals.length, 1);
  assert.equal(state.deals[0].stageId, 'NEW', 'a new deal starts at the first stage — a person moves it on');
  assert.equal(state.deals[0].contactId, 501);
  assert.equal(state.deals[0].title, 'Kwame Asante');
  assert.equal(state.records[0].status, 'created');

  assert.equal(state.sent.length, 2);
  assert.ok(onlyInTopic(), 'every Bitrix message in the Bitrix topic');
  assert.match(state.sent[0].text, /🆕 <b>Bitrix:<\/b> created a deal for <b>Kwame Asante<\/b> \(5552013344\) with a new contact/);
  assert.match(state.sent[0].text, /at <b>New Lead<\/b>[\s\S]*The post in General/);
  assert.match(state.sent[1].text, /move <b>Kwame Asante<\/b> to <b>Sent to Safety<\/b>\?\nNow: New Lead/);
  assert.equal(state.finished.at(-1).outcome.result, 'proposed');
  assert.equal(state.finished.at(-1).outcome.created, true);
});

test('read again (a new message, Telegram redelivering one): nothing is created or said twice', async () => {
  start();
  await run();
  assert.equal(await run(thread({ revision: 2 })), 'done');
  assert.equal(await run(thread({ revision: 3 })), 'done');
  assert.equal(adds('crm.contact.add'), 1);
  assert.equal(adds('crm.deal.add'), 1);
  assert.equal(state.sent.length, 2);
  assert.equal(state.finished.at(-1).outcome.result, 'already_proposed');
});

test('EXISTING CONTACT with this phone and name, no open deal: the contact is reused, only the deal is created', async () => {
  start();
  state.contacts.push({ id: 40, first: 'Kwame', last: 'Asante', phones: [PHONE] });
  state.deals.push({ id: 41, title: 'old', stageId: 'LOSE', categoryId: '0', contactId: 40, closed: true });
  await run();
  assert.equal(adds('crm.contact.add'), 0);
  assert.equal(state.deals.length, 2);
  assert.equal(state.deals[1].contactId, 40);
  assert.match(state.sent[0].text, /on the contact that already had this phone/);
  assert.equal(state.records[0].contactReused, true);
});

test('EXISTING DEAL, by phone or by name: used as it is — nothing is created', async () => {
  start();
  state.contacts.push({ id: 40, first: 'Kwame', last: 'Asante', phones: [PHONE] });
  state.deals.push({ id: 41, title: 'Facebook Lead – Kwame Asante', stageId: 'PREPARATION', categoryId: '0', contactId: 40 });
  await run();
  assert.equal(adds('crm.contact.add') + adds('crm.deal.add'), 0);
  assert.equal(state.records.length, 0, 'no creation was even claimed');
  assert.equal(state.sent.length, 1);
  assert.match(state.sent[0].text, /move <b>Kwame Asante<\/b> to <b>Sent to Safety<\/b>\?\nNow: Contacting/);

  start();
  state.contacts.push({ id: 40, first: 'Kwame', last: 'Asante', phones: ['5550009999'] });
  state.deals.push({ id: 41, title: 'Kwame Asante', stageId: 'PREPARATION', categoryId: '0', contactId: 40 });
  await run();
  assert.equal(adds('crm.contact.add') + adds('crm.deal.add'), 0);
  assert.match(state.sent[0].text, /move <b>Kwame Asante<\/b>/);
});

test('AMBIGUOUS IN BITRIX: nothing is created; a person is asked in the topic, with the reason', async () => {
  const cases = [
    [[{ id: 40, first: 'Kwame', last: 'Asante', phones: [PHONE] }, { id: 42, first: 'K', last: 'Asante', phones: [PHONE] }],
      /2 contacts in Bitrix have the phone 5552013344/],
    [[{ id: 40, first: 'Grace', last: 'Mensah', phones: [PHONE] }],
      /the phone 5552013344 belongs to another contact in Bitrix \(Grace Mensah\)/],
    [[{ id: 40, first: 'Kwame', last: 'Asante', phones: ['5550009999'] }],
      /a contact named Kwame Asante is already in Bitrix under another phone/],
  ];
  for (const [contacts, why] of cases) {
    start();
    state.contacts.push(...contacts);
    // eslint-disable-next-line no-await-in-loop
    await run();
    assert.equal(adds('crm.contact.add') + adds('crm.deal.add'), 0, String(why));
    assert.equal(state.proposals[0].kind, 'create_deal');
    assert.match(state.sent[0].text, /no open deal found for <b>Kwame Asante<\/b>/);
    assert.match(state.sent[0].text, why);
    assert.ok(onlyInTopic());
    assert.equal(state.records[0].status, 'blocked');
  }
});

test('TWO PEOPLE IN BITRIX match the name: said once in the topic; nothing moved, proposed or created', async () => {
  start();
  state.contacts.push({ id: 40, first: 'Kwame', last: 'Asante', phones: ['5550001111'] },
    { id: 43, first: 'Kwame', last: 'Asante', phones: ['5550002222'] });
  state.deals.push({ id: 41, title: 'a', stageId: 'NEW', categoryId: '0', contactId: 40 },
    { id: 44, title: 'b', stageId: 'NEW', categoryId: '0', contactId: 43 });
  await run();
  assert.equal(state.finished.at(-1).outcome.result, 'ambiguous');
  assert.equal(adds('crm.contact.add') + adds('crm.deal.add'), 0);
  assert.equal(state.proposals.length, 0);
  assert.match(state.sent[0].text, /2 different people in Bitrix match <b>Kwame Asante<\/b>/);
  assert.ok(onlyInTopic());
});

test('NOT ENOUGH TO BE CERTAIN — a team, two phones, no phone, a name the model read differently: nothing created', async () => {
  const cases = [
    ['Company team drivers 95 CPM\nKWAME ASANTE (main)\n(555) 201-3344\nYAW BOATENG\n(555) 201-5566', /more than one driver/],
    ['KWAME ASANTE\n(555) 201-3344\n(555) 201-7788', /more than one phone number/],
    ['KWAME ASANTE\n9+ yrs of exp', /no phone number was written/],
  ];
  for (const [post, why] of cases) {
    start(post);
    // eslint-disable-next-line no-await-in-loop
    await run();
    assert.equal(adds('crm.contact.add') + adds('crm.deal.add'), 0, post);
    assert.match(state.sent[0].text, why, post);
    assert.equal(state.records.length, 0);
  }
  start();
  state.aiAnswer = { move: true, stage_id: 'UC_SAFETY', driver_name: 'Matthew', evidence: 'CLH sent' };
  await run();
  assert.equal(adds('crm.contact.add'), 0);
  assert.match(state.sent[0].text, /not the post's name/);
});

test('TIMEOUT AFTER Bitrix created the contact: the retry finds it — one contact, one deal', async () => {
  start();
  state.fail['crm.contact.add'] = 'timeout_after';
  assert.equal(await run(), 'retry');
  assert.equal(state.contacts.length, 1, 'Bitrix did create it');
  assert.equal(state.records[0].status, 'creating_contact');
  assert.equal(state.sent.length, 0);

  assert.equal(await run(thread({ attempts: 2 })), 'done');
  assert.equal(adds('crm.contact.add'), 1, 'never added again');
  assert.equal(state.contacts.length, 1);
  assert.equal(state.deals.length, 1);
  assert.equal(state.records[0].contactReused, false, 'its own contact, found by phone and ORIGIN_ID');
  assert.match(state.sent[0].text, /with a new contact/);
});

test('TIMEOUT AFTER Bitrix created the deal: the retry finds it — still one deal, one notice', async () => {
  start();
  state.fail['crm.deal.add'] = 'timeout_after';
  assert.equal(await run(), 'retry');
  assert.equal(state.records[0].status, 'creating_deal');
  assert.equal(await run(thread({ attempts: 2 })), 'done');
  assert.equal(adds('crm.deal.add'), 1);
  assert.equal(state.deals.length, 1);
  assert.equal(state.sent.filter((s) => /🆕/.test(s.text)).length, 1);
  assert.equal(state.records[0].dealReused, false);
});

test('TIMEOUT BEFORE Bitrix did anything: the retry searches, finds nothing, and creates exactly one', async () => {
  start();
  state.fail['crm.deal.add'] = 'timeout';
  assert.equal(await run(), 'retry');
  assert.equal(state.deals.length, 0);
  assert.equal(await run(thread({ attempts: 2 })), 'done');
  assert.equal(state.deals.length, 1);
  assert.equal(state.contacts.length, 1);
});

test('BITRIX REFUSES: nothing created, the error said once in the topic; a later message tries again', async () => {
  start();
  state.fail['crm.contact.add'] = 'refuse';
  assert.equal(await run(), 'done');
  assert.equal(state.finished.at(-1).outcome.result, 'bitrix_error');
  assert.equal(state.contacts.length, 0);
  assert.equal(state.records[0].status, 'failed');
  assert.match(state.sent[0].text, /❗ <b>Bitrix error<\/b> while handling <b>Kwame Asante<\/b> — nothing was changed\.\nBitrix said: Bitrix crm\.contact\.add: Access denied/);
  assert.ok(onlyInTopic());

  assert.equal(await run(thread({ revision: 2 })), 'done');
  assert.equal(state.contacts.length, 1);
  assert.equal(state.deals.length, 1);
});

test('THE SAME DRIVER POSTED TWICE: the second waits while the first creates, then finds its deal', async () => {
  start();
  state.fail['crm.deal.add'] = 'timeout';
  assert.equal(await run(), 'retry', 'the first conversation is mid-creation');
  state.messages = conversation(CARD, 300);
  assert.equal(await run(thread({ id: 2, rootMessageId: 300, lastMessageId: 303 })), 'retry');
  assert.match(state.retried.at(-1).error, /another conversation is creating this driver/);

  state.messages = conversation(CARD);
  await run(thread({ attempts: 2 }));
  state.messages = conversation(CARD, 300);
  await run(thread({ id: 2, rootMessageId: 300, lastMessageId: 303, attempts: 2 }));
  assert.equal(state.contacts.length, 1);
  assert.equal(state.deals.length, 1, 'the second post found the first one\'s deal by phone');
});

test('"Skip" pressed on an earlier request means never — the bot does not create it either', async () => {
  start();
  state.proposals.push({ id: 1, rootMessageId: 169, kind: 'create_deal', status: 'declined' });
  await run();
  assert.equal(adds('crm.contact.add') + adds('crm.deal.add'), 0);
  assert.equal(state.finished.at(-1).outcome.result, 'already_asked');
  assert.equal(state.sent.length, 0);
});

test('what the bot creates is stamped with its origin, so it can be found again', async () => {
  start();
  await run();
  assert.equal(ORIGINATOR, 'wenze_recruiting');
  assert.equal(state.deals[0].originId, `tg:${h.CHAT}:169`);
});
