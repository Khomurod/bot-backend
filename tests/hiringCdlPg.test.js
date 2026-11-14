'use strict';

/**
 * Migrations 0107 and 0108 against a real PostgreSQL (owner, 14 November
 * 2026): a task's own providers (`ai_capabilities.provider_order`), the CDL →
 * Bitrix field map, and the record of each CDL read — which has NO column that
 * could hold a CDL value. Additive, and safe to run twice. Names are made up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();
const CHAT = '-1001234567890';

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const layer = h.loadDataLayer(['aiSettings', 'hiringStages/cdlFieldMap', 'hiringStages/cdlReads']);
  return {
    h, ai: layer.aiSettings, map: layer['hiringStages/cdlFieldMap'], reads: layer['hiringStages/cdlReads'],
  };
}

test('the columns and tables exist, are additive, and both migrations can run twice', { skip: skipWithoutPg() }, async (t) => {
  const { h } = await setup(t);
  const { rows: [col] } = await h.pool.query(
    `SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'ai_capabilities' AND column_name = 'provider_order'`,
  );
  assert.deepEqual([col.data_type, col.is_nullable], ['ARRAY', 'YES']);
  const { rows } = await h.pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'hiring_stage_cdl_reads' ORDER BY column_name`,
  );
  assert.deepEqual(rows.map((r) => r.column_name), [
    'chat_id', 'contact_id', 'created_at', 'deal_id', 'id', 'items_in_comment', 'items_written', 'model',
    'name_from_cdl', 'provider_key', 'request_message_id', 'root_message_id', 'status', 'written_items',
  ], 'no column for a CDL value — a new one must be a deliberate change to this test');
  await h.pool.query(allMigrationsSql((name) => name.startsWith('0107_') || name.startsWith('0108_')));
});

test('a task\'s own providers: saved in order, read back, handed back to the global order', { skip: skipWithoutPg() }, async (t) => {
  const { ai } = await setup(t);
  let row = await ai.setCapabilityProviderOrder('hiring_cdl_reading', ['gemini', 'anthropic'], {
    label: 'Read a candidate\'s CDL photo', updatedBy: 'owner',
  });
  assert.deepEqual(row.providerOrder, ['gemini', 'anthropic'], 'a task with no row yet gets one');
  assert.equal(row.aiEnabled, true);
  row = await ai.setCapabilityProviderOrder('hiring_cdl_reading', [], { updatedBy: 'owner' });
  assert.deepEqual(row.providerOrder, [], 'an empty list stays empty — nobody');
  await ai.updateCapability('hiring_cdl_reading', { aiEnabled: false });
  row = (await ai.listCapabilities()).find((c) => c.capabilityKey === 'hiring_cdl_reading');
  assert.deepEqual([row.aiEnabled, row.providerOrder, row.label], [false, [], 'Read a candidate\'s CDL photo']);
  await ai.registerCapability('translation', { label: 'Translate' });
  row = await ai.setCapabilityProviderOrder('translation', null, { updatedBy: 'owner' });
  assert.equal(row.providerOrder, null);
});

test('the field map: saved whole, one item per field, refused by the table when malformed', { skip: skipWithoutPg() }, async (t) => {
  const { h, map } = await setup(t);
  assert.deepEqual(await map.getFieldMap(), []);
  await map.saveFieldMap([
    { item: 'date_of_birth', entity: 'contact', fieldCode: 'BIRTHDATE', fieldLabel: 'Date of birth', fieldType: 'date' },
    { item: 'license_number', entity: 'deal', fieldCode: 'UF_CRM_1700000000', fieldLabel: 'CDL number', fieldType: 'string' },
  ], { updatedBy: 'owner' });
  const saved = await map.saveFieldMap([
    { item: 'license_number', entity: 'deal', fieldCode: 'UF_CRM_1700000000', fieldLabel: 'CDL number', fieldType: 'string' },
  ], { updatedBy: 'owner' });
  assert.deepEqual(saved.map((m) => m.item), ['license_number'], 'a save replaces the whole map');
  await assert.rejects(map.saveFieldMap([
    { item: 'license_number', entity: 'deal', fieldCode: 'UF_CRM_1' }, { item: 'license_class', entity: 'deal', fieldCode: 'UF_CRM_1' },
  ]), /uq_hiring_cdl_field_map_target/);
  assert.deepEqual((await map.getFieldMap()).map((m) => m.item), ['license_number'], 'a refused save changes nothing');
  await assert.rejects(h.pool.query("INSERT INTO hiring_cdl_field_map (cdl_item, entity, field_code) VALUES ('sex', 'lead', 'UF_X')"));
  await assert.rejects(h.pool.query("INSERT INTO hiring_cdl_field_map (cdl_item, entity, field_code) VALUES ('sex', 'deal', 'uf_x; drop')"));
});

test('a CDL read: once per tag; a written conversation never again; counts only; gone after 60 days',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, reads } = await setup(t);
    assert.equal(await reads.mayRead(CHAT, 169, 175), true);
    const off = await reads.recordRead({ chatId: CHAT, rootMessageId: 169, requestMessageId: 175, status: 'off' });
    assert.equal(off.status, 'off');
    assert.equal(await reads.recordRead({ chatId: CHAT, rootMessageId: 169, requestMessageId: 175, status: 'written' }), null,
      'a second ending for the same tag changes nothing');
    assert.equal(await reads.mayRead(CHAT, 169, 175), false, 'the same tag had its read');
    assert.equal(await reads.mayRead(CHAT, 169, 181), true, 'a new tag may try again');

    const written = await reads.recordRead({
      chatId: CHAT, rootMessageId: 169, requestMessageId: 181, status: 'written', providerKey: 'anthropic', model: 'claude-sonnet-5-5',
      itemsWritten: 9, itemsInComment: 3, writtenItems: ['date_of_birth', 'license_number'], nameFromCdl: true, dealId: 61, contactId: 41,
    });
    assert.deepEqual([written.itemsWritten, written.itemsInComment, written.writtenItems, written.nameFromCdl, written.dealId],
      [9, 3, ['date_of_birth', 'license_number'], true, 61]);
    assert.equal(await reads.mayRead(CHAT, 169, 190), false, 'a written CDL is never read again');
    assert.equal(await reads.mayRead(CHAT, 170, 190), true, 'another conversation is its own');
    await assert.rejects(h.pool.query(
      `INSERT INTO hiring_stage_cdl_reads (chat_id, root_message_id, request_message_id, status) VALUES ($1, 1, 1, 'A1234567')`, [CHAT],
    ), /check/i);
    assert.equal((await reads.listRecentReads(10)).length, 2);

    await h.pool.query("UPDATE hiring_stage_cdl_reads SET created_at = NOW() - INTERVAL '61 days' WHERE request_message_id = 175");
    assert.equal(await reads.purgeOldCdlReads(60), 1);
    assert.equal((await reads.listRecentReads(10)).length, 1);
  });
