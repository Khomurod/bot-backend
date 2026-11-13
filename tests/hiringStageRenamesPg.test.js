'use strict';

/**
 * Migration 0104 against a real PostgreSQL: the display name stored at the
 * creation claim (kept while a creation is in flight, renewed on a fresh
 * start), the card's aside question, and the rename offers — reserved once
 * per conversation and deal, one open per conversation, a press claimed once
 * and who pressed kept. Names and numbers are made up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();
const CHAT = '-1001234567890';
const PHONE = '5552013344';

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const layer = h.loadDataLayer(['hiringStages/crmRecords', 'hiringStages/cards', 'hiringStages/renames']);
  return {
    h, records: layer['hiringStages/crmRecords'], cards: layer['hiringStages/cards'], renames: layer['hiringStages/renames'],
  };
}

const claim = (records, displayName) => records.claim({
  chatId: CHAT, rootMessageId: 169, phone: PHONE, driverName: 'Goowin Leah Ann', displayName,
});

test('THE DISPLAY NAME is stored at the claim: kept while in flight, renewed only on a fresh start', { skip: skipWithoutPg() }, async (t) => {
  const { records } = await setup(t);
  const { record } = await claim(records, 'Leah Ann Goodwin');
  assert.deepEqual([record.driverName, record.displayName], ['Goowin Leah Ann', 'Leah Ann Goodwin']);
  await records.advance(record.id, 'claimed', 'creating_deal');
  assert.equal((await claim(records, 'Goowin Leah Ann')).record.displayName, 'Leah Ann Goodwin', 'a resumed creation writes what it started with');
  await records.advance(record.id, 'creating_deal', 'failed', { error: 'refused' });
  assert.equal((await claim(records, 'Leah A Goodwin')).record.displayName, 'Leah A Goodwin', 'a fresh start takes the new name');
  assert.equal((await records.getForRoot(CHAT, 169)).displayName, 'Leah A Goodwin');
});

test('the card\'s aside: set, kept while the question changes, cleared alone', { skip: skipWithoutPg() }, async (t) => {
  const { cards } = await setup(t);
  await cards.ensureCard(CHAT, 169, 'Goowin Leah Ann');
  const kb = { inline_keyboard: [[{ text: '✏️ Rename', callback_data: 'hst:rn:1' }]] };
  let card = await cards.updateCard(CHAT, 169, { aside: { text: 'rename?', keyboard: kb } });
  assert.deepEqual([card.asideText, card.asideKeyboard], ['rename?', kb]);
  card = await cards.updateCard(CHAT, 169, { current: { text: 'move?' }, line: 'x' });
  assert.deepEqual([card.currentText, card.asideText], ['move?', 'rename?']);
  card = await cards.updateCard(CHAT, 169, { aside: null, line: 'renamed' });
  assert.deepEqual([card.currentText, card.asideText, card.asideKeyboard], ['move?', null, null]);
});

test('A RENAME OFFER: once per conversation and deal, one open per conversation, a press claimed once', { skip: skipWithoutPg() }, async (t) => {
  const { h, renames } = await setup(t);
  const offer = (dealId, root = 169) => renames.reserveRename({
    chatId: CHAT, rootMessageId: root, dealId, categoryId: '0', fromTitle: 'No name  ', toName: 'Leah Ann Goodwin', contactId: 40,
  });
  const first = await offer(41);
  assert.deepEqual([first.status, first.fromTitle, first.toName, first.contactId], ['pending', 'No name  ', 'Leah Ann Goodwin', 40]);
  assert.equal(await offer(41), null, 'offered once');
  assert.equal(await offer(42), null, 'one open per conversation');
  assert.ok(await offer(42, 300), 'another conversation');

  const by = { userId: 4242, userName: 'Ann' };
  assert.ok(await renames.transition(first.id, 'pending', 'applying', by));
  assert.equal(await renames.transition(first.id, 'pending', 'applying', by), null, 'a second press finds nothing to claim');
  const done = await renames.transition(first.id, 'applying', 'applied', { ...by, contactRenamed: true });
  assert.deepEqual([done.status, done.decidedByName, done.contactRenamed, Boolean(done.decidedAt)], ['applied', 'Ann', true, true]);
  assert.equal(await offer(41), null, 'answered: never offered again');
  assert.ok(await offer(42), 'free for another deal once answered');

  const unsent = await offer(43, 400);
  await renames.transition(unsent.id, 'pending', 'unsent', { error: 'chat not found' });
  assert.equal((await offer(43, 400)).status, 'pending', 'a refused send is offered again');

  await h.pool.query("UPDATE hiring_stage_renames SET created_at = NOW() - INTERVAL '61 days'");
  assert.equal(await renames.purgeOldRenames(60), 1, 'only the answered one; open offers stay');
});
