'use strict';

/**
 * services/truckPhotos/pipeline.js with videos, and with a photo Wenze saw only
 * with the reply (the owner, 6 November 2026):
 *   - a video is listed in the PDF as a link — never downloaded, never shown
 *     to the model — and counted on the record;
 *   - videos alone make a PDF too;
 *   - a reply to a photo Wenze had not seen says, on the cover and in the
 *     caption, that photos sent with it may be missing;
 *   - a reply to an old photo looks only around that photo.
 * Names and ids are made up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { produceReport } = require('../services/truckPhotos/pipeline');
const {
  GROUP_CHAT, WORD_AT, photo, harness, groupWrites, reactions,
} = require('./helpers/truckPhotoPipelineHarness');

const video = (messageId, minutesBefore, over = {}) => photo(messageId, minutesBefore, {
  kind: 'video', fileId: `video-${messageId}`, durationSeconds: 35, thumbFileId: `thumb-${messageId}`, ...over,
});
const sentDocuments = (telegram) => telegram.log.filter((e) => e.method === 'sendDocument');

test('photos and videos: one PDF, the videos as links on their page — never downloaded, never judged by the model', async () => {
  const { telegram, calls, deps, job } = harness({
    photos: [photo(10, 30), video(11, 20), photo(12, 10), video(13, 5, { thumbFileId: null })],
  });
  const out = await produceReport(job, deps);
  assert.equal(out.status, 'sent');
  assert.deepEqual(calls.prepared, ['file-10', 'file-12'], 'only photos are downloaded');
  assert.deepEqual(calls.thumbs, ['thumb-11', null], 'for a video, at most its small preview');
  const built = calls.built[0];
  assert.equal(built.pages.length, 2);
  assert.deepEqual(built.videos.map((v) => [v.heading, v.link]), [
    ['Video 1 of 2 - 0:35', 'https://t.me/c/555/11'],
    ['Video 2 of 2 - 0:35', 'https://t.me/c/555/13'],
  ]);
  assert.ok(built.coverLines.some((l) => l.text === 'Videos: 2 - links on the next page'));
  assert.match(sentDocuments(telegram)[0].payload.caption, /2 photos, 2 videos/);
  assert.deepEqual(calls.finish[0], {
    ...calls.finish[0], status: 'sent', photoCount: 2, videoCount: 2, parts: 1,
  });
  assert.deepEqual(calls.marked.sort(), [100, 110, 120, 130], 'the videos are marked as sent too');
  assert.equal(reactions(telegram).length, 1);
  assert.deepEqual(groupWrites(telegram), []);
});

test('videos alone still make a PDF; the model is not asked about them', async () => {
  const { telegram, calls, deps, job } = harness({ photos: [video(11, 20), video(12, 10)] });
  const out = await produceReport(job, deps);
  assert.equal(out.status, 'sent');
  assert.equal(calls.filter, 0);
  assert.deepEqual(calls.prepared, []);
  assert.equal(calls.built.length, 1);
  assert.equal(calls.built[0].pages.length, 0);
  assert.equal(calls.built[0].videos.length, 2);
  assert.match(sentDocuments(telegram)[0].payload.caption, /- 2 videos/);
  assert.equal(calls.finish[0].photoCount, 0);
  assert.equal(calls.finish[0].videoCount, 2);
});

test('photos that could not be downloaded do not cost the videos their PDF', async () => {
  const { calls, deps, job } = harness({
    photos: [photo(10, 30), video(11, 20)],
    preparePhotos: async (list) => ({ ready: [], unreadable: list.length }),
  });
  const out = await produceReport(job, deps);
  assert.equal(out.status, 'sent');
  assert.ok(calls.built[0].coverLines.some((l) => /1 photo could not be downloaded/.test(l.text)));
});

test('a reply to a photo Wenze saw only with the reply: the cover, the caption and the record say photos may be missing', async () => {
  const old = photo(33, 10 * 24 * 60, { mediaGroupId: 'OLD' });
  const { telegram, calls, deps, job } = harness({
    photos: [old],
    message: { reply_to_message: { message_id: 33, chat: { id: Number(GROUP_CHAT) } } },
    job: { anchorSeenLate: true },
  });
  const out = await produceReport(job, deps);
  assert.equal(out.status, 'sent');
  assert.match(calls.built[0].coverLines.map((l) => l.text).join(' '), /the photo this was a reply to was sent .*, before Wenze saw it/);
  assert.match(sentDocuments(telegram)[0].payload.caption, /photos sent with it may be missing/);
  assert.match(calls.finish[0].reason, /before Wenze saw it; photos sent with it may be missing/);
});

test('a reply to a photo Wenze saw when it was sent carries no such note', async () => {
  const { telegram, calls, deps, job } = harness({
    message: { reply_to_message: { message_id: 10, chat: { id: Number(GROUP_CHAT) } } },
  });
  await produceReport(job, deps);
  assert.ok(!calls.built[0].coverLines.some((l) => /before Wenze saw it/.test(l.text)));
  assert.doesNotMatch(sentDocuments(telegram)[0].payload.caption, /missing/);
});

test('a reply to an old photo asks the store only for the hours around that photo', async () => {
  const old = photo(33, 10 * 24 * 60);
  const { calls, deps, job } = harness({
    photos: [old], message: { reply_to_message: { message_id: 33, chat: { id: Number(GROUP_CHAT) } } },
  });
  await produceReport(job, deps);
  const hour = 3600_000;
  assert.equal(calls.listed.since.getTime(), old.sentAt.getTime() - 3 * hour);
  assert.equal(calls.listed.until.getTime(), old.sentAt.getTime() + 3 * hour);
  assert.ok(calls.listed.until.getTime() < WORD_AT);
});
