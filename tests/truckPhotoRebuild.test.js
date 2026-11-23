'use strict';

/**
 * services/truckPhotos/rebuild.js — a corrected PDF, rebuilt and sent at once
 * (the owner, 23 November 2026): from what the last version held, or the time
 * a person named; the last sort reused unless "look again"; a person's
 * removing and putting back outranking the model; "CORRECTED - version 2" on
 * the cover; the next version recorded over the one it came from; and a
 * cancel that frees the photos and takes the 👍 back.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { rebuildReport, cancelReport } = require('../services/truckPhotos/rebuild');
const {
  RECIPIENT, GROUP_CHAT, photo, itemsV1, report, fakes,
} = require('./helpers/truckPhotoCorrectionHarness');

const SETTINGS = { recipientTelegramId: RECIPIENT, maxPhotosPerPdf: 60 };
const run = (deps, over = {}) => rebuildReport({
  report: report(), items: itemsV1(), edits: {}, kind: 'outbound', correction: { byName: 'Tom Robinson', summary: ['truck number 088 -> 027'] },
  profile: { first_name: 'Frantz', last_name: 'Arthus', unit_number: '088', driver_type: 'company_driver' },
  settings: SETTINGS, replyTo: 4242, telegram: {}, ...over,
}, deps);

test('a new truck number: the same photos, the last sort reused, the person\'s number on the cover, "CORRECTED"', async () => {
  const { calls, deps } = fakes();
  const out = await run(deps, { edits: { unit: '027', unitBy: 'Tom Robinson' } });
  assert.equal(out.status, 'sent');
  assert.equal(out.version, 2);
  assert.deepEqual(calls.sorted, [['jpeg-3']], 'only the photo nobody sorted before is sorted');
  const built = calls.built[0];
  assert.deepEqual(built.pages.map((p) => p.jpeg.toString()), ['jpeg-1', 'jpeg-2', 'jpeg-3', 'jpeg-4'], 'the form still closes it');
  const cover = built.coverLines.map((l) => l.text);
  assert.ok(cover.includes('Truck: 027 - Company (set by Tom Robinson)'), cover.join(' | '));
  assert.ok(cover.includes('CORRECTED - version 2, asked by Tom Robinson'));
  assert.ok(cover.includes('- truck number 088 -> 027'));
  const [sent] = calls.sent;
  assert.equal(sent.recipient, RECIPIENT, 'the PDF goes to the recipient');
  assert.equal(sent.replyTo, 4242, 'answering the message that asked');
  assert.equal(sent.fileName, 'outbound_027_2026-11-19.pdf');
  assert.match(sent.caption, /^CORRECTED - version 2, asked by Tom Robinson: truck number 088 -> 027/);
  assert.equal(calls.saved[0].fromVersion, 1, 'written over the version it came from');
  assert.deepEqual(calls.saved[0].edits, { unit: '027', unitBy: 'Tom Robinson' });
  assert.equal(calls.recorded[0].version, 2);
  assert.deepEqual(calls.recorded[0].messages, [{ chatId: RECIPIENT, messageId: 901, part: 1 }]);
  assert.deepEqual(calls.marked, [{ id: 9, ids: [1, 2, 3, 4, 6] }], 'the left-out document is not this report\'s');
});

test('removed by a person is out, put back is in, and the cover says who left them out', async () => {
  const { calls, deps } = fakes();
  await run(deps, { edits: { removed: [2], restored: [5] } });
  assert.deepEqual(calls.built[0].pages.map((p) => p.jpeg.toString()), ['jpeg-1', 'jpeg-3', 'jpeg-5', 'jpeg-4']);
  assert.ok(calls.built[0].coverLines.some((l) => l.text === 'Left out: 1 removed by hand'));
});

test('"look again": every photo is sorted afresh', async () => {
  const { calls, deps } = fakes({ sort: (jpegs) => ({ verdicts: jpegs.map((j) => (String(j) === 'jpeg-2' ? { kind: 'document', confidence: 95 } : { kind: 'truck_outside', confidence: 90 })), answered: 1, providers: ['gemini'], stopped: null }) });
  await run(deps, { recheck: true });
  assert.deepEqual(calls.sorted, [['jpeg-1', 'jpeg-2', 'jpeg-3', 'jpeg-4', 'jpeg-5']]);
  assert.deepEqual(calls.built[0].pages.map((p) => p.jpeg.toString()), ['jpeg-1', 'jpeg-3', 'jpeg-4', 'jpeg-5']);
});

test('a time a person named: the photos of that time, never one another report sent', async () => {
  const window = [photo(20, 30, { reportId: null }), photo(21, 31, { reportId: 9 }), photo(22, 32, { reportId: 7 })];
  const { calls, deps } = fakes({ window });
  await run(deps, { edits: { window: { from: '2026-11-19T21:00:00.000Z', until: '2026-11-20T00:00:00.000Z' } } });
  assert.equal(calls.listed[0].chat, GROUP_CHAT);
  assert.deepEqual(calls.built[0].pages.map((p) => p.jpeg.toString()), ['jpeg-20', 'jpeg-21']);
});

test('no items kept (a report that never had a PDF): the time the photos were first chosen from', async () => {
  const { calls, deps } = fakes({ window: [photo(30, 0, { reportId: null, messageId: 99 }), photo(31, 1, { reportId: null, messageId: 101 })] });
  await run(deps, { items: [] });
  assert.ok(calls.listed.length === 1);
  assert.deepEqual(calls.built[0].pages.map((p) => p.jpeg.toString()), ['jpeg-30'], 'never a photo sent after the word');
});

test('nothing left, not delivered, or raced: said, and nothing recorded', async () => {
  const none = fakes();
  assert.equal((await run(none.deps, { edits: { removed: [1, 2, 3, 4] }, items: itemsV1().filter((i) => i.place !== 'video') })).status, 'all_excluded');
  assert.equal(none.calls.saved.length, 0);

  const refused = fakes({ refuseSend: true });
  const out = await run(refused.deps);
  assert.equal(out.status, 'failed');
  assert.equal(refused.calls.saved.length, 0);
  assert.equal(refused.calls.marked.length, 0);

  const raced = fakes({ raced: true });
  assert.equal((await run(raced.deps)).recorded, false);
  assert.equal(raced.calls.recorded.length, 0, 'the version that landed first keeps its record');
});

test('a report that had no PDF before gets its 👍 on the word with its first one; a corrected one does not get another', async () => {
  const first = fakes({
    window: [photo(30, 0, { reportId: null, messageId: 99 })],
    deps: { reactDelivered: async (args) => { first.calls.reacted = args; } },
  });
  await run(first.deps, { report: report({ status: 'unclear' }), items: [], edits: {} });
  assert.deepEqual([first.calls.reacted?.chatId, first.calls.reacted?.messageId], [GROUP_CHAT, 100]);
  const again = fakes({ deps: { reactDelivered: async () => { again.calls.reacted = true; } } });
  await run(again.deps);
  assert.equal(again.calls.reacted, undefined);
});

test('a cancel: closed, photos freed, the 👍 on the word taken back', async () => {
  const { calls, deps } = fakes();
  const out = await cancelReport({ report: report(), edits: {}, byName: 'Tom Robinson', telegram: {} }, deps);
  assert.equal(out.status, 'cancelled');
  assert.equal(calls.saved[0].status, 'cancelled');
  assert.deepEqual(calls.marked, [{ id: 9, ids: [] }]);
  assert.deepEqual(calls.cleared.map((c) => [c.chatId, c.messageId]), [[GROUP_CHAT, 100]]);
});
