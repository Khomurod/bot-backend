'use strict';

/**
 * Migrations 0100 and 0101 against a real PostgreSQL: the claim that makes a
 * Bitrix contact + deal creation happen at most once, the notices posted
 * once, the Bitrix topic setting, and the one card per driver. Names and
 * numbers are made up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();
const CHAT = '-1001234567890';
const PHONE = '5552013344';

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const layer = h.loadDataLayer([
    'hiringStages/crmRecords', 'hiringStages/notices', 'hiringStages/cards', 'safetyApprovals/settings',
  ]);
  return {
    h,
    records: layer['hiringStages/crmRecords'],
    notices: layer['hiringStages/notices'],
    cards: layer['hiringStages/cards'],
    settings: layer['safetyApprovals/settings'],
  };
}

const claimFor = (records, rootMessageId, phone = PHONE) => records.claim({
  chatId: CHAT, rootMessageId, phone, driverName: 'Kwame Asante',
});

test('ONE CREATION PER CONVERSATION: a re-read gets its own claim back, where it left off', { skip: skipWithoutPg() }, async (t) => {
  const { records } = await setup(t);
  const { record } = await claimFor(records, 169);
  assert.equal(record.status, 'claimed');
  assert.ok(await records.advance(record.id, 'claimed', 'creating_contact'));
  assert.equal(await records.advance(record.id, 'claimed', 'creating_deal'), null, 'only from the status it is in');

  const again = await claimFor(records, 169);
  assert.equal(again.record.id, record.id);
  assert.equal(again.record.status, 'creating_contact', 'an unanswered call is resumed, not restarted');
  assert.equal(again.record.attempts, 2);

  const done = await records.advance(record.id, ['creating_contact'], 'creating_deal', { contactId: 501, contactReused: false });
  assert.equal(done.contactId, 501);
  const created = await records.advance(record.id, 'creating_deal', 'created', { dealId: 777, categoryId: '0', stageId: 'NEW' });
  assert.deepEqual([created.status, created.contactId, created.dealId, created.stageId], ['created', 501, 777, 'NEW']);
  assert.equal((await claimFor(records, 169)).record.status, 'created', 'a created one stays created');
});

test('THE SAME PHONE in two conversations: the second is busy while the first creates', { skip: skipWithoutPg() }, async (t) => {
  const { records } = await setup(t);
  const first = (await claimFor(records, 169)).record;
  assert.deepEqual(await claimFor(records, 300), { busy: true });
  await records.advance(first.id, 'claimed', 'creating_deal');
  assert.deepEqual(await claimFor(records, 300), { busy: true });
  await records.advance(first.id, 'creating_deal', 'created', { dealId: 777 });
  assert.equal((await claimFor(records, 300)).record.status, 'claimed', 'free once the first is done');
  assert.equal((await claimFor(records, 400, '5550001111')).record.status, 'claimed', 'another phone was never blocked');
});

test('blocked or refused: nothing in flight, and a later read may claim it again', { skip: skipWithoutPg() }, async (t) => {
  const { records } = await setup(t);
  const { record } = await claimFor(records, 169);
  const blocked = await records.advance(record.id, ['claimed'], 'blocked', { error: 'two contacts share the phone' });
  assert.equal(blocked.lastError, 'two contacts share the phone');
  assert.equal((await claimFor(records, 300)).record.status, 'claimed', 'a blocked claim holds no phone');
  const again = await claimFor(records, 169);
  assert.deepEqual(again, { busy: true }, 'conversation 300 is in flight for the same phone now');
});

test('a notice is reserved once; a refused send gives it back', { skip: skipWithoutPg() }, async (t) => {
  const { notices } = await setup(t);
  const id = await notices.reserve(CHAT, 169, 'created');
  assert.ok(id);
  assert.equal(await notices.reserve(CHAT, 169, 'created'), null);
  assert.ok(await notices.reserve(CHAT, 169, 'bitrix_error:2'), 'another key is another notice');
  assert.ok(await notices.reserve(CHAT, 170, 'created'), 'another conversation');
  await notices.release(id);
  assert.ok(await notices.reserve(CHAT, 169, 'created'));
});

test('the Bitrix topic: saved, not the approvals topic, forgotten with the group', { skip: skipWithoutPg() }, async (t) => {
  const { settings } = await setup(t);
  settings.invalidateCache();
  await settings.updateSafetyApprovalSettings({ chatId: CHAT, topicId: 3 });
  assert.equal((await settings.updateSafetyApprovalSettings({ bitrixTopicId: 77 })).bitrixTopicId, 77);
  await assert.rejects(settings.updateSafetyApprovalSettings({ bitrixTopicId: 3 }), /different topic/);
  await assert.rejects(settings.updateSafetyApprovalSettings({ topicId: 77 }), /different topic/);
  assert.equal((await settings.updateSafetyApprovalSettings({ safetyUserIds: ['900'] })).bitrixTopicId, 77, 'kept on another save');
  const moved = await settings.updateSafetyApprovalSettings({ chatId: '-100999' });
  assert.equal(moved.bitrixTopicId, null, 'a different group is a different set of topics');
});

test('after sixty days records and notices are deleted — a creation in flight stays', { skip: skipWithoutPg() }, async (t) => {
  const { h, records, notices } = await setup(t);
  const done = (await claimFor(records, 169)).record;
  await records.advance(done.id, 'claimed', 'created', { dealId: 1 });
  await claimFor(records, 300, '5550001111');
  await notices.reserve(CHAT, 169, 'created');
  await h.pool.query("UPDATE hiring_stage_crm_records SET created_at = NOW() - INTERVAL '61 days'");
  await h.pool.query("UPDATE hiring_stage_notices SET created_at = NOW() - INTERVAL '61 days'");
  assert.equal(await records.purgeOldRecords(60), 1);
  assert.deepEqual((await records.listRecentRecords(10)).map((r) => r.rootMessageId), [300]);
  assert.equal(await notices.purgeOldNotices(60), 1);
});

test('ONE CARD PER DRIVER: the name set once, lines appended, the question replaced or cleared', { skip: skipWithoutPg() }, async (t) => {
  const { h, cards } = await setup(t);
  await cards.ensureCard(CHAT, 169, 'Kwame Asante');
  await cards.ensureCard(CHAT, 169, 'K. Asante');
  let card = await cards.updateCard(CHAT, 169, { current: { text: 'q1', keyboard: { inline_keyboard: [[]] } }, messageId: 101 });
  assert.deepEqual([card.driverName, card.currentText, card.messageId], ['Kwame Asante', 'q1', 101]);
  assert.deepEqual(card.currentKeyboard, { inline_keyboard: [[]] });
  card = await cards.updateCard(CHAT, 169, { line: '✅ Moved', current: null });
  assert.deepEqual([card.history, card.currentText, card.currentKeyboard, card.messageId], [['✅ Moved'], null, null, 101]);
  await Promise.all([cards.updateCard(CHAT, 169, { line: 'a' }), cards.updateCard(CHAT, 169, { line: 'b' })]);
  assert.equal((await cards.getCard(CHAT, 169)).history.length, 3, 'two writers lose no line');
  assert.equal(await cards.updateCard(CHAT, 999, { line: 'x' }), null);

  await h.pool.query("UPDATE hiring_stage_cards SET updated_at = NOW() - INTERVAL '61 days'");
  assert.equal(await cards.purgeOldCards(60), 1);
});
