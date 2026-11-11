'use strict';

/**
 * services/hiringStages/card.js — ONE message per driver in the Bitrix topic
 * (owner, 11 November 2026). Pinned: a question re-posts the card at the
 * bottom and takes the old copy away (or points below when Telegram will not
 * delete it); an answer edits in place; a line of news is shown once per key;
 * nothing is sent without the topic. Names are made up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createCardStore } = require('./helpers/hiringStageCardStore');

const ROOT = path.resolve(__dirname, '..');
function stub(rel, exports) {
  const filename = require.resolve(path.resolve(ROOT, rel));
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const cardStore = createCardStore();
stub('database/hiringStages/cards.js', cardStore.store);
const reserved = new Set();
stub('database/hiringStages/notices.js', {
  reserve: async (c, r, key) => (reserved.has(`${r}:${key}`) ? null : (reserved.add(`${r}:${key}`), reserved.size)),
  recordSent: async () => {},
  release: async () => {},
});

const card = require('../services/hiringStages/card');

const CONV = { chatId: '-1001234567890', rootMessageId: 169, driverName: 'Kwame Asante' };

function fakeTelegram({ canDelete = true } = {}) {
  const t = { sent: [], edits: [], deleted: [] };
  t.sendMessage = async (chatId, text, extra) => { t.sent.push({ text, extra }); return { message_id: 100 + t.sent.length }; };
  t.editMessageText = async (chatId, id, _i, text, extra) => { t.edits.push({ id, text, extra }); return true; };
  t.deleteMessage = async (chatId, id) => {
    if (!canDelete) throw new Error('message can\'t be deleted');
    t.deleted.push(id);
    return true;
  };
  return t;
}

test('a new question moves the card to the bottom; the old copy goes', async () => {
  cardStore.reset(); reserved.clear();
  const tg = fakeTelegram();
  const first = await card.ask(tg, 77, CONV, { text: '📋 Move to <b>A</b>?', keyboard: { inline_keyboard: [] } });
  assert.equal(first, 101);
  assert.equal(tg.sent[0].extra.message_thread_id, 77);
  assert.match(tg.sent[0].text, /^👤 <b>Kwame Asante<\/b>/);

  assert.equal(await card.close(tg, { ...CONV, botMessageId: 101 }, '✅ Moved to <b>A</b>'), true);
  assert.equal(tg.sent.length, 1, 'an answer is an edit, not a message');
  assert.match(tg.edits.at(-1).text, /✅ Moved to <b>A<\/b>$/);
  assert.equal(tg.edits.at(-1).extra.reply_markup, undefined);

  const second = await card.ask(tg, 77, { ...CONV, driverName: 'K. Asante' }, { text: '📋 Move to <b>B</b>?' });
  assert.equal(second, 102);
  assert.deepEqual(tg.deleted, [101]);
  assert.match(tg.sent[1].text, /^👤 <b>Kwame Asante<\/b>[\s\S]*✅ Moved to <b>A<\/b>\n\n📋 Move to <b>B<\/b>\?$/, 'the first name stays');
});

test('a copy Telegram will not delete is edited to point below', async () => {
  cardStore.reset(); reserved.clear();
  const tg = fakeTelegram({ canDelete: false });
  await card.ask(tg, 77, CONV, { text: 'q1' });
  await card.ask(tg, 77, CONV, { text: 'q2' });
  assert.match(tg.edits.at(-1).text, /Updated — see the newer message below/);
  assert.equal(tg.edits.at(-1).id, 101);
});

test('a line of news is shown once per key, and never without the topic', async () => {
  cardStore.reset(); reserved.clear();
  const tg = fakeTelegram();
  assert.equal(await card.note(tg, 77, CONV, { key: 'created', line: '🆕 Deal created' }), true);
  assert.equal(await card.note(tg, 77, CONV, { key: 'created', line: '🆕 Deal created' }), false);
  assert.equal(tg.sent.length, 1);
  assert.equal(await card.note(tg, null, CONV, { key: 'other', line: 'x' }), false);
  await assert.rejects(card.ask(tg, null, CONV, { text: 'q' }), /no Bitrix topic/);
  assert.equal(tg.sent.length, 1);
});

test('a message from before cards is not a card: the caller edits it the old way', async () => {
  cardStore.reset(); reserved.clear();
  const tg = fakeTelegram();
  assert.equal(await card.close(tg, { ...CONV, botMessageId: 5555 }, 'x'), false);
  assert.equal(tg.edits.length, 0);
});
