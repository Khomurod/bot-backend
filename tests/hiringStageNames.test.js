'use strict';

/**
 * Hiring deal names (owner, 13–14 November 2026) — the pure rules:
 * lib/hiringStages/displayName.js (Safety's spelling and order, by rules),
 * lib/hiringStages/identity.js (found by the post's words, written in the
 * display name), lib/hiringStages/conversation.js (Safety's words, Safety's
 * #NotApproved), lib/hiringStages/placeholder.js (when a rename may be
 * offered) and the card's words. Names and numbers are made up, apart from
 * the production examples the owner quoted.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { displayName, wordsMatch } = require('../lib/hiringStages/displayName');
const { candidateIdentity } = require('../lib/hiringStages/identity');
const conversation = require('../lib/hiringStages/conversation');
const {
  isPlaceholderTitle, isHiringPipeline, isPlaceholderContact, mayOfferRename,
} = require('../lib/hiringStages/placeholder');
const msg = require('../lib/hiringStages/messages');

const name = (postName, safetyTexts) => displayName({ postName, safetyTexts }).name;

test('THE GOOWIN EXAMPLE: Safety\'s spelling, and the CDL order LAST FIRST MIDDLE → FIRST MIDDLE LAST', () => {
  assert.deepEqual(displayName({ postName: 'Goowin Leah Ann', safetyTexts: ['LEAH GOODWIN APPROVED'] }), {
    name: 'Leah Ann Goodwin', source: 'safety', order: 'surname_last',
  });
  assert.equal(name('Thelamon Marcson Jose', ['CLH sent', 'Marcson Thelamon clean']), 'Marcson Jose Thelamon');
});

test('a Safety run covering every post word gives Safety\'s order and spelling', () => {
  assert.equal(name('Johnes Destin', ['#NotApproved Destin Jones 3 accidents']), 'Destin Jones');
  assert.equal(name('Hills Emanuel Jr', ['emanuel hills approved']), 'Emanuel Hills Jr', 'a suffix stays last');
  assert.equal(name('Sharp James Edward Iii', ['JAMES EDWARD SHARP approved']), 'James Edward Sharp III');
});

test('otherwise the post\'s ORDER is kept — never guessed — with Safety\'s spelling', () => {
  // Safety's run does not end with the post's first word: no reordering.
  assert.equal(name('Leah Ann Goowin', ['Ann Goodwin is clean']), 'Leah Ann Goodwin');
  assert.equal(name('Goowin Leah Ann', ['GOODWIN LEAH clean']), 'Goodwin Leah Ann');
});

test('a post-only name keeps its order and spelling exactly (today\'s behaviour)', () => {
  assert.deepEqual(displayName({ postName: 'Phillips Samuel Jahbari', safetyTexts: [] }), {
    name: 'Phillips Samuel Jahbari', source: 'post', order: 'post',
  });
  assert.equal(name('Phillips Samuel Jahbari', ['CLH sent', 'Done', 'CLEAN']), 'Phillips Samuel Jahbari');
});

test('a Safety message that matches FEWER THAN TWO words is ignored', () => {
  assert.equal(name('Goowin Leah Ann', ['Leah approved']), 'Goowin Leah Ann');
  assert.equal(name('Goowin Leah Ann', ['Goodwin 3 Leah']), 'Goowin Leah Ann', 'a number breaks the run');
  assert.equal(name('Kwame Asante', ['Kwame and Asante']), 'Kwame Asante');
});

test('one letter edit only between words of five letters or more; equal ignoring case always', () => {
  assert.equal(wordsMatch('GOODWIN', 'Goowin'), true);
  assert.equal(wordsMatch('Jones', 'Johnes'), true);
  assert.equal(wordsMatch('LEAH', 'leah'), true);
  assert.equal(wordsMatch('Lean', 'Leah'), false, 'short words must be equal');
  assert.equal(wordsMatch('Goodman', 'Goowin'), false);
  assert.equal(name('Kwame Lean', ['KWAME LEAH approved']), 'Kwame Lean');
});

test('identity: FOUND by the post\'s words, WRITTEN in the display name; a model\'s name is never a spelling', () => {
  const post = 'Company Driver - 99 CPM\nGOOWIN LEAH ANN\n(555) 201-3344';
  const withSafety = candidateIdentity({ postText: post, phones: ['5552013344'], safetyTexts: ['LEAH GOODWIN APPROVED'] });
  assert.deepEqual(withSafety, {
    ok: true, name: 'Goowin Leah Ann', displayName: 'Leah Ann Goodwin', first: 'Leah Ann', last: 'Goodwin', phone: '5552013344',
  });
  // The model named the driver its own way: checked against the post, never written.
  const modelOnly = candidateIdentity({ postText: post, phones: ['5552013344'], modelName: 'Leah Ann Goowin' });
  assert.equal(modelOnly.displayName, 'Goowin Leah Ann');
  assert.equal(modelOnly.last, 'Ann');
  assert.equal(candidateIdentity({ postText: post, phones: ['5552013344'], modelName: 'Leah Goodwin' }).reason, 'name_mismatch');
});

test('Safety\'s words are read from Safety only — not the post, not a recruiter — and #NotApproved by rule', () => {
  const m = (messageId, fromUserId, text) => ({
    messageId, fromUserId, text, photos: [], documents: [], mediaGroupId: null,
  });
  const messages = [
    m(169, '900', 'GOOWIN LEAH ANN\n(555) 201-3344'),
    m(170, '500', 'Leah Goodman sent'),
    m(171, '900', 'LEAH GOODWIN #NotApproved'),
  ];
  const who = { rootMessageId: 169, safetyUserIds: ['900'] };
  assert.deepEqual(conversation.safetyTexts(messages, who), ['LEAH GOODWIN #NotApproved']);
  assert.equal(conversation.safetyRejected(messages, who), true);
  assert.equal(conversation.safetyRejected([...messages, m(175, '900', '#Approved after all')], who), false);
  assert.equal(conversation.safetyRejected([...messages.slice(0, 2), m(176, '500', '#NotApproved')], who), false,
    'a recruiter\'s hashtag decides nothing');
});

test('a placeholder title, a hiring pipeline, a placeholder contact', () => {
  for (const t of ['No name  ', 'no name', 'NoName', '', '   ', null, '12345']) assert.equal(isPlaceholderTitle(t), true, String(t));
  for (const t of ['Leah Goodwin', 'Facebook Lead – Kwame Asante', 'No name yet']) assert.equal(isPlaceholderTitle(t), false, t);
  assert.equal(isHiringPipeline('0'), true);
  assert.equal(isHiringPipeline('11'), true);
  assert.equal(isHiringPipeline('3'), false, 'DRIVER RELATION — the Board check owns its titles');
  assert.equal(isHiringPipeline(33), false, 'HOMETIME MONITORING');
  assert.equal(isPlaceholderContact({ first: '', last: '', name: '' }), true);
  assert.equal(isPlaceholderContact({ first: 'No', last: 'name', name: 'No name' }), true);
  assert.equal(isPlaceholderContact({ first: 'Leah', last: 'Goodwin', name: 'Leah Goodwin' }), false);
  const deal = { id: 7, title: 'No name  ', categoryId: '0', closed: false };
  assert.equal(mayOfferRename(deal, 'Leah Ann Goodwin'), true);
  assert.equal(mayOfferRename({ ...deal, categoryId: '3' }, 'Leah Ann Goodwin'), false);
  assert.equal(mayOfferRename({ ...deal, title: 'Leah Goodwin' }, 'Leah Ann Goodwin'), false);
  assert.equal(mayOfferRename(deal, null), false);
});

test('the card\'s words: the offer, its buttons, the answers', () => {
  const r = { id: 5, fromTitle: 'No name  ', toName: 'Leah Ann Goodwin' };
  assert.equal(msg.renameText(r), '✏️ Name in Bitrix: “No name” → “Leah Ann Goodwin”?');
  assert.deepEqual(msg.renameKeyboard(5).inline_keyboard[0].map((b) => [b.text, b.callback_data]),
    [['✏️ Rename', 'hst:rn:5'], ['Keep as is', 'hst:rk:5']]);
  assert.match('hst:rn:5', msg.CALLBACK_PATTERN);
  assert.match('hst:rk:5', msg.CALLBACK_PATTERN);
  assert.equal(msg.renameOutcomeLine({ ...r, contactRenamed: true }, 'applied', { byName: 'Ann' }),
    '✏️ Renamed in Bitrix: “No name” → “Leah Ann Goodwin” (and its contact) — Ann');
  assert.equal(msg.renameOutcomeLine(r, 'declined', { byName: 'Ann' }), '✏️ Name left as “No name” — Ann');
  assert.match(msg.closedDealLine({ dealId: 9, dealTitle: 'Johnes Destin', stageName: 'Lost' }),
    /The deal “Johnes Destin” is closed \(Lost\) — nothing to create/);
  const card = {
    driverName: 'X', chatId: '-1001', rootMessageId: 1, history: [], current: 'Q', aside: 'A',
    currentKeyboard: { inline_keyboard: [[{ text: 'a' }]] }, asideKeyboard: { inline_keyboard: [[{ text: 'b' }]] },
  };
  assert.match(msg.cardText(card), /Q\n\nA$/);
  assert.equal(msg.cardKeyboard(card).inline_keyboard.length, 2);
  assert.equal(msg.cardKeyboard({}), null);
});
