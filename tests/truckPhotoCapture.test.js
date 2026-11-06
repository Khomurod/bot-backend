'use strict';

/**
 * services/truckPhotos/capture.js — remembering driver-group photos. Only
 * file ids are kept; the largest size of a photo; a picture sent "as a file"
 * but no other document; never a bot's picture; nothing while switched off or
 * outside a driver group; and it NEVER throws at the bot. Ids are made up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { captureTruckPhoto, shapePhoto } = require('../services/truckPhotos/capture');

const CHAT = -100555;

function harness(over = {}) {
  const stored = [];
  let settingsReads = 0;
  const deps = {
    getSettings: async () => { settingsReads += 1; return { enabled: over.enabled ?? true }; },
    getGroup: async () => (over.group === undefined ? { id: 3, group_type: 'driver', active: false } : over.group),
    upsertPhoto: over.upsertPhoto || (async (row) => { stored.push(row); return true; }),
  };
  return { deps, stored, reads: () => settingsReads };
}

const message = (over = {}) => ({
  message_id: 11, chat: { id: CHAT, type: 'supergroup' }, from: { id: 5001, first_name: 'Jerome', last_name: 'Joyner' },
  date: 1762444800, media_group_id: 'ALB',
  photo: [
    { file_id: 'small', file_unique_id: 's', width: 90, height: 60, file_size: 900 },
    { file_id: 'big', file_unique_id: 'b', width: 1280, height: 960, file_size: 180000 },
    { file_id: 'mid', file_unique_id: 'm', width: 320, height: 240, file_size: 9000 },
  ],
  ...over,
});

test('a photo is remembered by its largest size, as a file id — and an inactive driver group counts', async () => {
  const { deps, stored } = harness();
  const out = await captureTruckPhoto(message(), deps);
  assert.deepEqual(out, { captured: true, isNew: true });
  assert.deepEqual(stored[0], {
    chatId: String(CHAT), groupId: 3, messageId: 11, mediaGroupId: 'ALB', fromUserId: 5001, fromName: 'Jerome Joyner',
    fileId: 'big', fileUniqueId: 'b', kind: 'photo', width: 1280, height: 960, fileSize: 180000,
    durationSeconds: null, thumbFileId: null, sentAt: new Date(1762444800 * 1000),
  });
  assert.ok(!('bytes' in stored[0]) && !('buffer' in stored[0]), 'never the picture itself');
});

test('a picture sent "as a file" counts; a PDF or a voice note does not', async () => {
  const { deps, stored } = harness();
  await captureTruckPhoto(message({
    photo: undefined, document: { file_id: 'doc', file_unique_id: 'd', mime_type: 'image/jpeg', file_size: 4_000_000 },
  }), deps);
  assert.equal(stored[0].kind, 'document');
  assert.equal(stored[0].fileId, 'doc');

  for (const other of [
    { photo: undefined, document: { file_id: 'pdf', mime_type: 'application/pdf' } },
    { photo: undefined, voice: { file_id: 'v' } },
    { photo: undefined, text: 'outbound' },
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const out = await captureTruckPhoto(message(other), deps);
    assert.equal(out.reason, 'no_picture');
  }
  assert.equal(stored.length, 1);
});

test('a message without a picture costs nothing — not even a settings read', async () => {
  const h = harness();
  await captureTruckPhoto(message({ photo: undefined, text: 'on my way' }), h.deps);
  assert.equal(h.reads(), 0);
});

test('switched off, not a driver group, a bot, a private chat: nothing is remembered', async () => {
  const cases = [
    [harness({ enabled: false }), message(), 'switched_off'],
    [harness({ group: { id: 4, group_type: 'recruitment' } }), message(), 'not_a_driver_group'],
    [harness({ group: null }), message(), 'not_a_driver_group'],
    [harness(), message({ from: { id: 1, is_bot: true } }), 'not_a_person'],
    [harness(), message({ chat: { id: 5001, type: 'private' } }), 'not_a_group'],
  ];
  for (const [h, msg, reason] of cases) {
    // eslint-disable-next-line no-await-in-loop
    const out = await captureTruckPhoto(msg, h.deps);
    assert.equal(out.reason, reason);
    assert.equal(h.stored.length, 0, reason);
  }
});

test('it never throws: a database failure, a broken message or nothing at all', async () => {
  const failing = harness({ upsertPhoto: async () => { throw new Error('database is down'); } });
  assert.deepEqual(await captureTruckPhoto(message(), failing.deps), { captured: false, reason: 'error' });
  const broken = harness();
  broken.deps.getSettings = async () => { throw new Error('connection reset'); };
  assert.equal((await captureTruckPhoto(message(), broken.deps)).reason, 'error');
  assert.equal((await captureTruckPhoto(undefined, broken.deps)).reason, 'not_a_group');
  assert.equal((await captureTruckPhoto({ chat: { type: 'group' }, photo: [{ file_id: 'x' }] }, harness().deps)).reason, 'not_a_person');
});

test('shapePhoto is pure and refuses what has no sender', () => {
  assert.equal(shapePhoto({ chat: { id: 1 }, message_id: 1, photo: [{ file_id: 'x' }] }, { id: 1 }), null);
});

test('a video, a round video note and a video sent as a file are remembered as videos, with length and preview — never the video', async () => {
  const { deps, stored } = harness();
  const noPhoto = { photo: undefined };
  await captureTruckPhoto(message({
    ...noPhoto, message_id: 21,
    video: { file_id: 'vid', file_unique_id: 'v', width: 1920, height: 1080, duration: 35, file_size: 9_000_000, thumbnail: { file_id: 'vthumb' } },
  }), deps);
  await captureTruckPhoto(message({
    ...noPhoto, message_id: 22, media_group_id: undefined,
    video_note: { file_id: 'note', file_unique_id: 'n', length: 384, duration: 12, thumb: { file_id: 'nthumb' } },
  }), deps);
  await captureTruckPhoto(message({
    ...noPhoto, message_id: 23, media_group_id: undefined,
    document: { file_id: 'vfile', file_unique_id: 'f', mime_type: 'video/quicktime', file_size: 30_000_000 },
  }), deps);
  assert.deepEqual(stored.map((r) => [r.messageId, r.kind, r.fileId, r.durationSeconds, r.thumbFileId, r.width]), [
    [21, 'video', 'vid', 35, 'vthumb', 1920],
    [22, 'video', 'note', 12, 'nthumb', 384],
    [23, 'video', 'vfile', null, null, null],
  ]);
});

test('a GIF is not a video of the truck, and a document that is neither picture nor video is not remembered', async () => {
  const { deps, stored } = harness();
  const out = await captureTruckPhoto(message({
    photo: undefined,
    animation: { file_id: 'gif', duration: 3 },
    document: { file_id: 'gifdoc', mime_type: 'video/mp4' },
  }), deps);
  assert.equal(out.captured, false);
  await captureTruckPhoto(message({ photo: undefined, document: { file_id: 'pdf', mime_type: 'application/pdf' } }), deps);
  assert.equal(stored.length, 0);
});

test('a second sighting of a remembered photo says it was not new', async () => {
  const { deps } = harness({ upsertPhoto: async () => false });
  assert.deepEqual(await captureTruckPhoto(message(), deps), { captured: true, isNew: false });
});
