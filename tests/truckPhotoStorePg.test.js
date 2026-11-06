'use strict';

/**
 * The Truck Photos stores against a real PostgreSQL: migration 0096 applied
 * twice, the settings' switch that the table itself refuses without a reached
 * recipient, the UNIQUE claim that makes a redelivered word a no-op, a finish
 * that only writes a pending row, `report_id` marking only unsent photos, the
 * inbound's "last outbound", the stale-claim sweep, the driver's accounts, and
 * the 30-day retention of the photo buffer. Names and ids are made up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();
const CHAT = '-1001234567890';
const MIGRATION = fs.readFileSync(
  path.join(__dirname, '..', 'database', 'migrations', '0096_truck_photo_reports.sql'), 'utf8',
);

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const layer = h.loadDataLayer([
    'truckPhotos/settings', 'truckPhotos/photos', 'truckPhotos/reports', 'truckPhotos/driverContext', 'pool',
  ]);
  const { rows } = await h.query(
    `INSERT INTO groups (telegram_group_id, group_name, group_type) VALUES ($1, 'Jerome Joyner 1', 'driver') RETURNING id`,
    [CHAT],
  );
  layer['truckPhotos/settings'].invalidateCache();
  return {
    h,
    groupId: rows[0].id,
    settings: layer['truckPhotos/settings'],
    photos: layer['truckPhotos/photos'],
    reports: layer['truckPhotos/reports'],
    driver: layer['truckPhotos/driverContext'],
    query: layer.pool.query,
  };
}

const photoRow = (groupId, messageId, sentAt, over = {}) => ({
  chatId: CHAT, groupId, messageId, mediaGroupId: null, fromUserId: 5001, fromName: 'Jerome Joyner',
  fileId: `file-${messageId}`, fileUniqueId: `u-${messageId}`, kind: 'photo', width: 1280, height: 960,
  fileSize: 150000, sentAt, ...over,
});

test('the migration applies twice; off by default; the table refuses ON without a reached recipient',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, settings } = await setup(t);
    await h.query(MIGRATION); // a second time: additive and idempotent
    const initial = await settings.getTruckPhotoSettings();
    assert.deepEqual(
      [initial.enabled, initial.recipientTelegramId, initial.lookbackHours, initial.maxPhotosPerPdf],
      [false, null, 3, 60],
    );
    await assert.rejects(
      h.query("UPDATE truck_photo_settings SET enabled = TRUE, recipient_telegram_id = 1234567 WHERE id = 1"),
      /truck_photo_settings_enable_needs_recipient/,
      'saved but never reached is refused by the table itself',
    );
    await assert.rejects(h.query('UPDATE truck_photo_settings SET lookback_hours = 25'), /truck_photo_settings_lookback/);
    await assert.rejects(h.query('UPDATE truck_photo_settings SET recipient_telegram_id = -100555'), /truck_photo_settings_recipient/);

    await assert.rejects(settings.updateTruckPhotoSettings({ enabled: true }), /Before switching/);
    await settings.updateTruckPhotoSettings({ recipientTelegramId: '7000000001', lookbackHours: 4 }, 5);
    assert.equal(await settings.markRecipientVerified('7000000999'), null, 'a proof for another person is no proof');
    const reached = await settings.markRecipientVerified('7000000001');
    assert.ok(reached.recipientVerifiedAt);
    const on = await settings.updateTruckPhotoSettings({ enabled: true });
    assert.equal(on.enabled, true);
    assert.equal(on.recipientTelegramId, '7000000001', 'a bigint id survives as a string');
    const moved = await settings.updateTruckPhotoSettings({ recipientTelegramId: '7000000002' });
    assert.deepEqual([moved.enabled, moved.recipientVerifiedAt, moved.lookbackHours], [false, null, 4]);
  });

test('the claim is UNIQUE per message: Telegram redelivering a word gets nothing', { skip: skipWithoutPg() }, async (t) => {
  const { reports, groupId } = await setup(t);
  const claim = { chatId: CHAT, groupId, triggerMessageId: 100, kind: 'outbound', triggeredBy: 7002, triggeredByName: 'Kim Rowe' };
  const [a, b] = await Promise.all([reports.claimReport(claim), reports.claimReport(claim)]);
  assert.equal([a, b].filter(Boolean).length, 1, 'two at once: exactly one wins');
  assert.equal(await reports.claimReport(claim), null);
  assert.ok(await reports.claimReport({ ...claim, chatId: '-100999' }), 'the same message id in another chat is another word');

  const id = a || b;
  assert.equal(await reports.finishReport(id, {
    status: 'sent', photoCount: 5, parts: 1, aiAssisted: true, aiProvider: 'gemini', sent: true,
  }), true);
  assert.equal(await reports.finishReport(id, { status: 'failed', reason: 'late' }), false, 'only a pending row is finished');
  const [row] = await reports.listRecentReports(5).then((rows) => rows.filter((r) => r.id === id));
  assert.deepEqual(
    [row.status, row.photoCount, row.aiAssisted, row.aiProvider, row.groupName, row.triggeredByName, Boolean(row.sentAt)],
    ['sent', 5, true, 'gemini', 'Jerome Joyner 1', 'Kim Rowe', true],
  );
  await assert.rejects(reports.finishReport(id, { status: 'pending' }), /not a finished status/);
});

test('photos: remembered once, read by window, and report_id marks only the unsent', { skip: skipWithoutPg() }, async (t) => {
  const { photos, reports, groupId } = await setup(t);
  const at = (iso) => new Date(iso);
  assert.equal(await photos.upsertPhoto(photoRow(groupId, 10, at('2026-11-06T09:00:00Z'))), true);
  assert.equal(await photos.upsertPhoto(photoRow(groupId, 10, at('2026-11-06T09:00:00Z'))), false, 'a redelivered photo is not doubled');
  await photos.upsertPhoto(photoRow(groupId, 11, at('2026-11-06T11:00:00Z'), { mediaGroupId: 'ALB', kind: 'document' }));
  await photos.upsertPhoto(photoRow(groupId, 12, at('2026-11-06T11:30:00Z')));

  const since = await photos.listPhotosSince(CHAT, at('2026-11-06T10:00:00Z'));
  assert.deepEqual(since.map((p) => p.messageId), [11, 12]);
  assert.deepEqual([since[0].chatId, since[0].fromUserId, since[0].mediaGroupId, since[0].kind], [CHAT, '5001', 'ALB', 'document']);
  assert.equal((await photos.getPhotoByMessage(CHAT, 11)).fileId, 'file-11');
  assert.equal(await photos.getPhotoByMessage(CHAT, 999), null);

  const first = await reports.claimReport({ chatId: CHAT, groupId, triggerMessageId: 50, kind: 'outbound' });
  const second = await reports.claimReport({ chatId: CHAT, groupId, triggerMessageId: 51, kind: 'outbound' });
  assert.equal(await photos.markPhotosInReport(since.map((p) => p.id), first), 2);
  assert.equal(await photos.markPhotosInReport(since.map((p) => p.id), second), 0, 'the first PDF a photo went out in is its own');
  const after = await photos.listPhotosSince(CHAT, at('2026-11-06T00:00:00Z'));
  assert.deepEqual(after.map((p) => p.reportId), [null, first, first]);
});

test('an inbound finds the group\'s last DELIVERED outbound before it', { skip: skipWithoutPg() }, async (t) => {
  const { h, reports, groupId } = await setup(t);
  assert.equal(await reports.lastSentOutbound(groupId, new Date()), null);
  const make = async (messageId, status, createdAt, photoCount) => {
    const id = await reports.claimReport({ chatId: CHAT, groupId, triggerMessageId: messageId, kind: 'outbound' });
    await h.query('UPDATE truck_photo_reports SET status = $2, created_at = $3, photo_count = $4 WHERE id = $1', [id, status, createdAt, photoCount]);
  };
  await make(1, 'sent', '2026-10-20T10:00:00Z', 30);
  await make(2, 'sent', '2026-10-28T14:00:00Z', 38);
  await make(3, 'failed', '2026-11-01T10:00:00Z', 0);
  await make(4, 'sent', '2026-11-07T10:00:00Z', 12); // after the inbound
  const found = await reports.lastSentOutbound(groupId, new Date('2026-11-06T16:00:00Z'));
  assert.deepEqual([found.at.toISOString(), found.photoCount], ['2026-10-28T14:00:00.000Z', 38]);
});

test('the sweep closes only claims left pending past the threshold', { skip: skipWithoutPg() }, async (t) => {
  const { h, reports, groupId } = await setup(t);
  const old = await reports.claimReport({ chatId: CHAT, groupId, triggerMessageId: 1, kind: 'inbound', triggeredByName: 'Kim Rowe' });
  const fresh = await reports.claimReport({ chatId: CHAT, groupId, triggerMessageId: 2, kind: 'outbound' });
  const queued = await reports.claimReport({ chatId: CHAT, groupId, triggerMessageId: 3, kind: 'outbound' });
  await h.query("UPDATE truck_photo_reports SET created_at = NOW() - INTERVAL '45 minutes' WHERE id = ANY($1::bigint[])", [[old, queued]]);
  const closed = await reports.failStaleReports(30, 'Wenze stopped (a restart) before it could finish this PDF.', [queued]);
  assert.deepEqual(closed.map((r) => [r.id, r.status, r.groupName, r.triggeredByName]), [[old, 'failed', 'Jerome Joyner 1', 'Kim Rowe']]);
  const { rows } = await h.query('SELECT id, status FROM truck_photo_reports ORDER BY id');
  assert.deepEqual(rows.map((r) => r.status), ['failed', 'pending', 'pending'], 'a report this process still works on is left alone');
  assert.equal(rows[1].id, String(fresh));
});

test('the driver\'s accounts: open identities and the profile\'s id; a closed one is not; team or solo', { skip: skipWithoutPg() }, async (t) => {
  const { h, driver, groupId } = await setup(t);
  assert.deepEqual(await driver.readDriverContext(groupId), { profile: null, accountIds: [], isTeam: null });
  await h.query(
    `INSERT INTO driver_profiles (group_id, first_name, last_name, unit_number, telegram_user_id) VALUES ($1, 'Jerome', 'Joyner', '1', 5001)`,
    [groupId],
  );
  const { rows: [person] } = await h.query(`INSERT INTO driver_people (display_name) VALUES ('Jerome Joyner') RETURNING id`);
  await h.query(`INSERT INTO driver_person_groups (person_id, group_id, association_source) VALUES ($1, $2, 'manual')`, [person.id, groupId]);
  await h.query(
    `INSERT INTO driver_person_telegram_identities (person_id, telegram_user_id, link_source) VALUES ($1, 5009, 'manual')`,
    [person.id],
  );
  await h.query(
    `INSERT INTO driver_person_telegram_identities (person_id, telegram_user_id, link_source, ended_at) VALUES ($1, 4004, 'manual', NOW())`,
    [person.id],
  );
  const solo = await driver.readDriverContext(groupId);
  assert.deepEqual(solo.accountIds.sort(), ['5001', '5009']);
  assert.equal(solo.isTeam, false);
  assert.equal(solo.profile.unit_number, '1');
  await h.query(`UPDATE driver_profiles SET secondary_first_name = 'Bo' WHERE group_id = $1`, [groupId]);
  assert.equal((await driver.readDriverContext(groupId)).isTeam, true);
});

test('the photo buffer is pruned after 30 days by the retention pass; the reports are kept', { skip: skipWithoutPg() }, async (t) => {
  const { h, photos, reports, groupId, query } = await setup(t);
  await photos.upsertPhoto(photoRow(groupId, 1, new Date(Date.now() - 31 * 86400_000)));
  await photos.upsertPhoto(photoRow(groupId, 2, new Date(Date.now() - 29 * 86400_000)));
  const id = await reports.claimReport({ chatId: CHAT, groupId, triggerMessageId: 9, kind: 'outbound' });
  await h.query("UPDATE truck_photo_reports SET created_at = NOW() - INTERVAL '400 days' WHERE id = $1", [id]);
  // eslint-disable-next-line global-require
  const retention = require('../services/operations/dataRetention');
  const out = await retention.runDataRetentionPass({
    deps: { query, safety: { pruneOldSafetyEvents: async () => 0 }, aiCallLog: { pruneAiCallLog: async () => 0 } },
  });
  assert.deepEqual(out.errors, []);
  assert.equal(out.deleted.truckPhotos, 1);
  const left = await h.query('SELECT message_id FROM driver_group_photos');
  assert.deepEqual(left.rows.map((r) => r.message_id), ['2']);
  assert.equal((await h.query('SELECT COUNT(*)::int AS n FROM truck_photo_reports')).rows[0].n, 1, 'the record of a PDF is kept');
});

test('deleting a group takes its photos with it and leaves its reports', { skip: skipWithoutPg() }, async (t) => {
  const { h, photos, reports, groupId } = await setup(t);
  await photos.upsertPhoto(photoRow(groupId, 1, new Date()));
  await reports.claimReport({ chatId: CHAT, groupId, triggerMessageId: 9, kind: 'outbound' });
  await h.query('DELETE FROM groups WHERE id = $1', [groupId]);
  assert.equal((await h.query('SELECT COUNT(*)::int AS n FROM driver_group_photos')).rows[0].n, 0);
  const { rows } = await h.query('SELECT group_id FROM truck_photo_reports');
  assert.deepEqual(rows, [{ group_id: null }]);
});
