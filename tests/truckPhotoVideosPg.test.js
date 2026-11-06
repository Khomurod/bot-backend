'use strict';

/**
 * Truck Photos' videos against a real PostgreSQL (migration 0097): a video is
 * remembered with its length and preview, the old kinds still pass and an
 * unknown one is still refused, the store's window can end before the word,
 * and a report records its videos — which an inbound's "Outbound on" reads.
 * Names and ids are made up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();
const CHAT = '-1001234567890';
const MIGRATION = fs.readFileSync(
  path.join(__dirname, '..', 'database', 'migrations', '0097_truck_photo_videos.sql'), 'utf8',
);

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const layer = h.loadDataLayer(['truckPhotos/photos', 'truckPhotos/reports']);
  const { rows } = await h.query(
    `INSERT INTO groups (telegram_group_id, group_name, group_type) VALUES ($1, 'Tashayla Brooks 004', 'driver') RETURNING id`,
    [CHAT],
  );
  return { h, groupId: rows[0].id, photos: layer['truckPhotos/photos'], reports: layer['truckPhotos/reports'] };
}

const row = (groupId, messageId, sentAt, over = {}) => ({
  chatId: CHAT, groupId, messageId, mediaGroupId: null, fromUserId: 5001, fromName: 'Tashayla Brooks',
  fileId: `file-${messageId}`, fileUniqueId: `u-${messageId}`, kind: 'photo', width: 1280, height: 960,
  fileSize: 150000, sentAt, ...over,
});

test('the migration applies twice; a video is kept with its length and preview; an unknown kind is still refused',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, groupId, photos } = await setup(t);
    await h.query(MIGRATION);
    const at = new Date('2026-11-06T19:40:00Z');
    assert.equal(await photos.upsertPhoto(row(groupId, 1, at)), true);
    assert.equal(await photos.upsertPhoto(row(groupId, 2, at, {
      kind: 'video', durationSeconds: 35, thumbFileId: 'thumb-2', width: 1920, height: 1080,
    })), true);
    assert.equal(await photos.upsertPhoto(row(groupId, 2, at, { kind: 'video' })), false, 'a redelivery is not new');
    const listed = await photos.listPhotosSince(CHAT, new Date(at.getTime() - 60_000));
    assert.deepEqual(listed.map((p) => [p.messageId, p.kind, p.durationSeconds, p.thumbFileId]), [
      [1, 'photo', null, null], [2, 'video', 35, 'thumb-2'],
    ]);
    await assert.rejects(photos.upsertPhoto(row(groupId, 3, at, { kind: 'audio' })), /driver_group_photos_kind/);
  });

test('the window can end before the word: a reply to an old photo reads only its hours', { skip: skipWithoutPg() }, async (t) => {
  const { groupId, photos } = await setup(t);
  const day = (d, hh) => new Date(`2026-11-0${d}T${hh}:00:00Z`);
  await photos.upsertPhoto(row(groupId, 1, day(2, '09')));
  await photos.upsertPhoto(row(groupId, 2, day(2, '11')));
  await photos.upsertPhoto(row(groupId, 3, day(5, '11')));
  const around = await photos.listPhotosSince(CHAT, day(2, '06'), undefined, day(2, '12'));
  assert.deepEqual(around.map((p) => p.messageId), [1, 2]);
  const since = await photos.listPhotosSince(CHAT, day(2, '06'));
  assert.deepEqual(since.map((p) => p.messageId), [1, 2, 3]);
});

test('a report records its videos, and the next inbound reads them in "Outbound on"', { skip: skipWithoutPg() }, async (t) => {
  const { groupId, reports } = await setup(t);
  const id = await reports.claimReport({ chatId: CHAT, groupId, triggerMessageId: 811, kind: 'outbound' });
  assert.equal(await reports.finishReport(id, {
    status: 'sent', photoCount: 4, videoCount: 2, parts: 1, sent: true,
  }), true);
  const last = await reports.lastSentOutbound(groupId, new Date(Date.now() + 60_000));
  assert.deepEqual([last.photoCount, last.videoCount], [4, 2]);
  const [recent] = await reports.listRecentReports(5);
  assert.equal(recent.videoCount, 2);
});
