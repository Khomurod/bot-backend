'use strict';

/**
 * ✏️ Rename of a placeholder deal title, the edges of the press — through the
 * REAL reviewer, rename and buttons against the stateful fake Bitrix
 * (tests/helpers/hiringStageCrmHarness.js, whose reads mirror the real
 * client's: an empty TITLE reads back null, a deleted record reads null):
 *
 *   - an EMPTY title is offered and renamed (not "renamed meanwhile");
 *   - a deal moved into the Board's pipeline 3, or closed, after the offer is
 *     never written at the press;
 *   - a person who typed the same name is "renamed meanwhile", not the bot;
 *   - a title written before the contact failed is said, and never written twice;
 *   - offered whatever the stage read says, and with two phones;
 *   - a deleted known deal neither blocks the read nor a creation.
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
const PHONE = '5552013344';
const calls = (method) => state.calls.filter((c) => c === method).length;
const safety = (messageId, text) => m(messageId, {
  fromUserId: SAFETY, fromName: 'Safety', text, replyToMessageId: 169,
});

function placeholderDeal({
  post = GOOWIN, title = 'No name  ', categoryId = '0', contact = { first: '', last: '' },
} = {}) {
  h.reset();
  state.messages = [...conversation(post), safety(175, 'LEAH GOODWIN APPROVED')];
  state.contacts.push({ id: 40, ...contact, phones: [PHONE] });
  state.deals.push({
    id: 41, title, stageId: 'PREPARATION', categoryId, contactId: 40, closed: false,
  });
}

test('an EMPTY title (read back as null, as Bitrix does) is offered and renamed on the press', async () => {
  placeholderDeal({ title: '' });
  await run();
  assert.equal(state.renames.length, 1);
  assert.equal(state.renames[0].fromTitle, '');
  assert.match(state.sent.at(-1).text, /✏️ Name in Bitrix: “” → “Leah Ann Goodwin”\?/);
  const out = await press('rn', 1);
  assert.match(out.text, /renamed to Leah Ann Goodwin/);
  assert.equal(state.deals[0].title, 'Leah Ann Goodwin');
  assert.equal(state.renames[0].status, 'applied');
});

test('a deal MOVED INTO THE BOARD\'S PIPELINE 3 after the offer is never written at the press', async () => {
  placeholderDeal();
  await run();
  assert.equal(state.renames.length, 1);
  state.deals[0].categoryId = '3';
  const out = await press('rn', 1);
  assert.match(out.text, /Not renamed: the deal is closed or no longer in a hiring pipeline/);
  assert.equal(calls('crm.deal.update') + calls('crm.contact.update'), 0);
  assert.equal(state.deals[0].title, 'No name  ');
  assert.equal(state.renames[0].status, 'stale');
  assert.match(state.edits.at(-1).text, /✏️ Not renamed: the deal is closed or no longer in a hiring pipeline/);

  placeholderDeal();
  await run();
  state.deals[0].closed = true;
  assert.match((await press('rn', 1)).text, /Not renamed/);
  assert.equal(calls('crm.deal.update'), 0, 'nor a deal closed since the offer');
});

test('a person who typed THE SAME NAME meanwhile: "renamed meanwhile", never recorded as the bot\'s rename', async () => {
  placeholderDeal();
  await run();
  state.deals[0].title = 'Leah Ann Goodwin';
  const out = await press('rn', 1);
  assert.match(out.text, /Renamed meanwhile — left as is/);
  assert.equal(calls('crm.deal.update') + calls('crm.contact.update'), 0);
  assert.equal(state.renames[0].status, 'stale');
  assert.doesNotMatch(state.edits.at(-1).text, /Renamed in Bitrix:/);
});

test('the TITLE written, then the contact failed: said so; the next press finishes the contact, never the title twice', async () => {
  placeholderDeal();
  await run();
  state.fail['crm.contact.get'] = 'refuse';
  const first = await press('rn', 1);
  assert.match(first.text, /The deal is renamed to Leah Ann Goodwin, but Bitrix did not answer for its contact/);
  assert.equal(state.deals[0].title, 'Leah Ann Goodwin');
  assert.equal(state.renames[0].status, 'pending');
  assert.equal(state.renames[0].titleWritten, true);

  const second = await press('rn', 1);
  assert.match(second.text, /Done — renamed to Leah Ann Goodwin/);
  assert.equal(calls('crm.deal.update'), 1, 'the title once');
  assert.equal(calls('crm.contact.update'), 1);
  assert.deepEqual([state.contacts[0].first, state.contacts[0].last], ['Leah Ann', 'Goodwin']);
  assert.equal(state.renames[0].status, 'applied');
});

test('a deal DELETED after the offer: the press says so and writes nothing', async () => {
  placeholderDeal();
  await run();
  state.deals = [];
  assert.match((await press('rn', 1)).text, /no longer exists/);
  assert.equal(state.renames[0].status, 'stale');
  assert.equal(calls('crm.deal.update'), 0);
});

test('OFFERED WHATEVER THE READ SAYS: no stage move, or two phones (no creation would be certain)', async () => {
  placeholderDeal();
  state.aiAnswer = {
    move: false, stage_id: null, driver_name: null, evidence: '',
  };
  assert.equal(await run(), 'done');
  assert.equal(state.renames.length, 1);
  assert.equal(state.renames[0].toName, 'Leah Ann Goodwin');
  assert.match(state.sent.at(-1).text, /✏️ Name in Bitrix: “No name” → “Leah Ann Goodwin”\?/);
  assert.equal(calls('crm.deal.update'), 0, 'offered, not written');

  placeholderDeal({ post: 'Company Driver - 99 CPM\nGOOWIN LEAH ANN\n(555) 201-3344\n(555) 201-7788' });
  await run();
  assert.equal(state.renames.length, 1);
  assert.equal(state.renames[0].toName, 'Leah Ann Goodwin');
  assert.equal(state.renames[0].dealId, 41);
});

test('a KNOWN DEAL DELETED in Bitrix neither ends the read in an error nor blocks a creation', async () => {
  h.reset();
  state.messages = conversation('Company Driver - 99 CPM\nKWAME ASANTE\n(555) 201-3344');
  state.proposals.push({
    id: 1, rootMessageId: 169, kind: 'move', status: 'applied', dealId: 6533, toStageId: 'LOSE',
  });
  assert.equal(await run(), 'retry');
  assert.notEqual(state.finished.at(-1)?.outcome?.result, 'bitrix_error');
  assert.equal(calls('crm.deal.add'), 1);
  assert.equal(state.deals[0].title, 'Kwame Asante');
  assert.doesNotMatch(state.sent.map((s) => s.text).join('\n'), /Bitrix error|❗/);
});

test('no single certain name on the post: nothing is offered', async () => {
  placeholderDeal({ post: 'Company Driver - 99 CPM\n(555) 201-3344' });
  await run(thread());
  assert.equal(state.renames.length, 0);
});
