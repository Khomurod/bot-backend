'use strict';

/**
 * Truck Photos' corrections against a real PostgreSQL (migration 0109): the
 * migration applies twice; who may correct is a list of user ids; a message
 * finds its report and a word its report; what a version held is read back in
 * PDF order with its sort; a new version lands only over the one it came from;
 * a report's photos are exactly the ones it holds now, never another report's;
 * `cancelled` is a status. Names and ids are made up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const CHAT = '-1001234567890';
const RECIPIENT = '7000000001';
const MIGRATION = fs.readFileSync(path.join(__dirname, '..', 'database', 'migrations', '0109_truck_photo_corrections.sql'), 'utf8');

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: allMigrationsSql() });
  const layer = h.loadDataLayer(['truckPhotos/settings', 'truckPhotos/photos', 'truckPhotos/reports', 'truckPhotos/corrections']);
  const { rows } = await h.query(
    `INSERT INTO groups (telegram_group_id, group_name, group_type) VALUES ($1, 'WENZE UNIT # 027 FRANTZ ARTHUS', 'driver') RETURNING id`,
    [CHAT],
  );
  layer['truckPhotos/settings'].invalidateCache();
  const groupId = rows[0].id;
  const photoIds = [];
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await layer['truckPhotos/photos'].upsertPhoto({
      chatId: CHAT, groupId, messageId: 10 + i, fromUserId: 5001, fromName: 'Marco Jose', fileId: `f${i}`,
      kind: i === 4 ? 'video' : 'photo', sentAt: new Date(Date.UTC(2026, 10, 19, 21, i)),
    });
  }
  const { rows: ids } = await h.query('SELECT id FROM driver_group_photos ORDER BY message_id');
  photoIds.push(...ids.map((r) => Number(r.id)));
  const reportId = await layer['truckPhotos/reports'].claimReport({
    chatId: CHAT, groupId, triggerMessageId: 100, kind: 'outbound', triggeredBy: 7002, triggeredByName: 'Marvin Jackson',
  });
  return {
    h, groupId, photoIds, reportId, settings: layer['truckPhotos/settings'], reports: layer['truckPhotos/reports'], c: layer['truckPhotos/corrections'],
  };
}

test('the migration applies twice; the correctors are user ids, the recipient never doubled', { skip: skipWithoutPg() }, async (t) => {
  const { h, settings } = await setup(t);
  await h.query(MIGRATION);
  await settings.updateTruckPhotoSettings({ recipientTelegramId: RECIPIENT, editorTelegramIds: `4444, ${RECIPIENT} 5555 4444` });
  assert.deepEqual((await settings.getTruckPhotoSettings()).editorTelegramIds, ['4444', '5555']);
  await assert.rejects(settings.updateTruckPhotoSettings({ editorTelegramIds: ['-100555'] }), /Telegram user id/);
  await settings.updateTruckPhotoSettings({ editorTelegramIds: [] });
  assert.deepEqual((await settings.getTruckPhotoSettings()).editorTelegramIds, []);
});

test('a message finds its report, a word its report; a version\'s items come back in PDF order with their sort', { skip: skipWithoutPg() }, async (t) => {
  const {
    c, reportId, photoIds, groupId,
  } = await setup(t);
  await c.saveWindow(reportId, { from: new Date('2026-11-19T18:00:00Z'), until: new Date('2026-11-19T22:00:00Z') });
  await c.recordVersion({
    reportId,
    version: 1,
    items: [
      { photoId: photoIds[0], place: 'truck', position: 1, kind: 'truck_outside', confidence: 95.4 },
      { photoId: photoIds[1], place: 'left_out', kind: 'document', confidence: 90 },
      { photoId: photoIds[2], place: 'form', position: 1, kind: 'handover_form', confidence: 88 },
      { photoId: photoIds[3], place: 'truck', position: 2 },
      { photoId: photoIds[4], place: 'video', position: 1 },
      { photoId: photoIds[0], place: 'nonsense', position: 9 },
    ],
    messages: [{ chatId: RECIPIENT, messageId: 901, part: 1 }, { chatId: RECIPIENT, messageId: 902, part: 0 }],
  });
  const found = await c.findByMessage(RECIPIENT, 901);
  assert.deepEqual([found.report.id, found.report.groupId, found.report.groupName, found.version, found.part],
    [reportId, groupId, 'WENZE UNIT # 027 FRANTZ ARTHUS', 1, 1]);
  assert.ok(found.report.photosFrom);
  assert.equal(await c.findByMessage(RECIPIENT, 999), null);
  assert.equal((await c.findByTrigger(CHAT, 100)).id, reportId);
  assert.equal(await c.findByTrigger(CHAT, 101), null);
  assert.equal(await c.latestPdfMessage(reportId, RECIPIENT), 901, 'a question (part 0) is not a PDF to answer under');

  const items = await c.listItems(reportId, 1);
  assert.deepEqual(items.map((i) => [i.place, i.position, i.verdict?.kind ?? null, i.verdict?.confidence ?? null]), [
    ['truck', 1, 'truck_outside', 95], ['left_out', null, 'document', 90], ['form', 1, 'handover_form', 88],
    ['truck', 2, null, null], ['video', 1, null, null],
  ]);
  assert.equal(items[4].photo.kind, 'video');
  assert.deepEqual((await c.getPhotos([photoIds[2], photoIds[0]])).map((p) => p.id), [photoIds[0], photoIds[2]]);
});

test('a version lands only over the one it came from; a report holds exactly its photos, never another\'s', { skip: skipWithoutPg() }, async (t) => {
  const {
    h, c, reports, reportId, photoIds, groupId,
  } = await setup(t);
  await reports.finishReport(reportId, { status: 'sent', photoCount: 3, parts: 1, sent: true });
  const other = await reports.claimReport({ chatId: CHAT, groupId, triggerMessageId: 200, kind: 'inbound' });
  await h.query('UPDATE driver_group_photos SET report_id = $1 WHERE id = $2', [other, photoIds[3]]);
  await h.query('UPDATE driver_group_photos SET report_id = $1 WHERE id = ANY($2::bigint[])', [reportId, [photoIds[0], photoIds[1]]]);

  const edits = { unit: '027', unitBy: 'Tom Robinson', removed: [photoIds[1]] };
  assert.equal(await c.saveVersion(reportId, {
    fromVersion: 1, kind: 'inbound', edits, correctedByName: 'Tom Robinson', photoCount: 2, parts: 1, aiAssisted: true, aiProvider: 'openrouter',
  }), true);
  assert.equal(await c.saveVersion(reportId, { fromVersion: 1, kind: 'outbound', edits: {} }), false, 'the same version twice: the second loses');
  const r = await c.getReport(reportId);
  assert.deepEqual([r.version, r.kind, r.status, r.edits], [2, 'inbound', 'sent', edits]);

  await c.setReportPhotos(reportId, [photoIds[0], photoIds[2], photoIds[3]]);
  const { rows } = await h.query('SELECT id, report_id FROM driver_group_photos ORDER BY message_id');
  assert.deepEqual(rows.map((x) => (x.report_id === null ? null : Number(x.report_id))), [reportId, null, reportId, other, null],
    'the removed one is freed; another report\'s stays its own');

  assert.equal(await c.saveVersion(reportId, {
    fromVersion: 2, kind: 'inbound', status: 'cancelled', edits, correctedByName: 'Tom Robinson',
  }), true);
  assert.equal((await c.getReport(reportId)).status, 'cancelled');
  await assert.rejects(h.query("UPDATE truck_photo_reports SET status = 'nonsense' WHERE id = $1", [reportId]), /truck_photo_reports_status/);
  const [listed] = (await reports.listRecentReports(5)).filter((x) => x.id === reportId);
  assert.deepEqual([listed.version, listed.correctedByName], [3, 'Tom Robinson']);
});
