'use strict';

/**
 * services/truckPhotos/pipeline.js — one hand-over, from the claimed word to
 * the recipient's chat, with the database and the model replaced and the REAL
 * Telegram senders (services/truckPhotos/deliver.js) talking to a fake client.
 *
 * What the owner was promised, each pinned here:
 *   - 👍 on the word only after the PDF was delivered;
 *   - with no model, a bare word still makes a PDF of every photo; a word with
 *     more around it makes none and the recipient is told "could not tell";
 *   - a model may only LEAVE OUT photos;
 *   - every failure is a private message to the recipient, and the driver's
 *     group hears nothing at all.
 * Names and ids are made up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { produceReport, runTruckPhotoReport } = require('../services/truckPhotos/pipeline');

const {
  GROUP_CHAT, RECIPIENT, WORD_AT, photo, ALBUM_AND_SINGLES, harness, groupWrites, reactions,
} = require('./helpers/truckPhotoPipelineHarness');

test('a bare word: one PDF of the album and the singles to the recipient, then 👍, then the records', async () => {
  const { telegram, calls, deps, job } = harness();
  const out = await produceReport(job, deps);
  assert.equal(out.status, 'sent');
  const docs = telegram.log.filter((e) => e.method === 'sendDocument');
  assert.equal(docs.length, 1);
  assert.equal(docs[0].chat, RECIPIENT, 'to the one person, privately');
  assert.equal(docs[0].payload.document.filename, 'outbound_1_2026-11-06.pdf');
  assert.ok(Buffer.isBuffer(docs[0].payload.document.source), 'from a buffer — nothing on disk');
  assert.equal(calls.built[0].pages.length, 5);
  assert.deepEqual(reactions(telegram).map((r) => [r.chat, r.messageId, r.reaction[0].emoji]), [[GROUP_CHAT, 100, '👍']]);
  assert.deepEqual(calls.order, ['build', 'send', 'react', 'mark', 'finish:sent'], '👍 only after the delivery');
  assert.deepEqual(calls.marked, [100, 110, 120, 150, 160]);
  assert.equal(calls.handover, 0, 'a bare word asks no model whether it is a hand-over');
  assert.equal(calls.finish[0].aiAssisted, false, 'no model answered, and that is recorded');
  assert.deepEqual(groupWrites(telegram), []);
});

test('the PDF is not delivered: no 👍, the recipient is told, the group hears nothing', async () => {
  const { telegram, calls, deps, job } = harness({ telegram: { refuseDocument: () => true } });
  const out = await produceReport(job, deps);
  assert.equal(out.status, 'failed');
  assert.equal(reactions(telegram).length, 0);
  assert.deepEqual(calls.marked, [], 'the photos can go in the next PDF');
  assert.equal(calls.finish[0].status, 'failed');
  assert.match(calls.finish[0].reason, /did not accept the PDF/);
  const told = telegram.log.filter((e) => e.method === 'sendMessage');
  assert.equal(told.length, 1);
  assert.equal(told[0].chat, RECIPIENT);
  assert.match(told[0].text, /^Truck photos: no PDF was made\.\nOUTBOUND in "Jerome Joyner 1", marked by Kim Rowe/);
  assert.deepEqual(groupWrites(telegram), []);
});

test('no model at all, bare word: every photo goes in, unfiltered', async () => {
  const { calls, deps, job } = harness({ filter: () => ({ excluded: new Set(), answered: 0, providers: [] }) });
  await produceReport(job, deps);
  assert.equal(calls.built[0].pages.length, 5);
  assert.equal(calls.finish.at(-1).status, 'sent');
  assert.equal(calls.finish.at(-1).aiAssisted, false);
  assert.equal(calls.finish.at(-1).excludedCount, 0);
});

test('no model at all, a word with more around it: no PDF, and the recipient is told Wenze did not guess', async () => {
  const { telegram, calls, deps, job } = harness({
    trigger: { kind: 'outbound', bare: false }, message: { text: 'outbound 562 to Mike' },
    handover: { verdict: 'unavailable', provider: null },
  });
  const out = await produceReport(job, deps);
  assert.equal(out.status, 'unclear');
  assert.equal(calls.built.length, 0);
  assert.equal(telegram.log.filter((e) => e.method === 'sendDocument').length, 0);
  assert.equal(calls.finish[0].status, 'unclear');
  assert.equal(calls.finish[0].aiAssisted, false);
  const [told] = telegram.log.filter((e) => e.method === 'sendMessage');
  assert.equal(told.chat, RECIPIENT);
  assert.match(told.text, /could not be reached, so Wenze did not guess/);
  assert.deepEqual(groupWrites(telegram), []);
  assert.equal(reactions(telegram).length, 0);
});

test('a model that cannot tell: no PDF, "could not tell"; a model sure it is a load: nothing sent, nobody told', async () => {
  const unsure = harness({ trigger: { kind: 'inbound', bare: false }, handover: { verdict: 'unclear', provider: 'gemini' } });
  await produceReport(unsure.job, unsure.deps);
  assert.equal(unsure.calls.finish[0].status, 'unclear');
  assert.equal(unsure.calls.finish[0].aiAssisted, true);
  assert.match(unsure.telegram.log.find((e) => e.method === 'sendMessage').text, /could not tell whether/);

  const load = harness({
    trigger: { kind: 'outbound', bare: false }, message: { text: 'outbound load from Chicago' },
    handover: { verdict: 'no', provider: 'groq' },
  });
  const out = await produceReport(load.job, load.deps);
  assert.equal(out.status, 'not_a_handover');
  assert.equal(load.calls.finish[0].status, 'not_a_handover');
  assert.equal(load.calls.finish[0].aiProvider, 'groq');
  assert.deepEqual(load.telegram.log, [], 'not about the truck: not a PDF, not a message, not a 👍');
});

test('a model may only LEAVE OUT photos — and what it leaves out is counted', async () => {
  const { calls, deps, job } = harness({
    filter: (jpegs) => ({ excluded: new Set([1, 3]), answered: 1, providers: ['gemini'] }),
  });
  await produceReport(job, deps);
  const pages = calls.built[0].pages.map((p) => p.jpeg.toString());
  assert.deepEqual(pages, ['jpeg-10', 'jpeg-12', 'jpeg-16']);
  const done = calls.finish.at(-1);
  assert.equal(done.photoCount, 3);
  assert.equal(done.excludedCount, 2);
  assert.equal(done.aiAssisted, true);
  assert.equal(done.aiProvider, 'gemini');
  assert.deepEqual(calls.marked, [100, 120, 160], 'a photo left out was not sent, so it is not marked as sent');
});

test('every photo left out: no PDF, the recipient is told why', async () => {
  const { telegram, calls, deps, job } = harness({
    filter: (jpegs) => ({ excluded: new Set(jpegs.map((_, i) => i)), answered: 1, providers: ['gemini'] }),
  });
  const out = await produceReport(job, deps);
  assert.equal(out.status, 'no_photos');
  assert.match(telegram.log.find((e) => e.method === 'sendMessage').text, /None of the 5 photos looked like the truck/);
  assert.equal(calls.finish[0].excludedCount, 5);
});

test('no photos, or only photos already sent: the recipient is told which', async () => {
  const none = harness({ photos: [] });
  await produceReport(none.job, none.deps);
  assert.equal(none.calls.finish[0].status, 'no_photos');
  assert.match(none.telegram.log[0].text, /No photos or videos from the 3 hours before the message/);

  const sent = harness({ photos: [photo(10, 20, { reportId: 9 })] });
  await produceReport(sent.job, sent.deps);
  assert.match(sent.telegram.log[0].text, /already in an earlier PDF/);
  assert.deepEqual(groupWrites(sent.telegram), []);
});

test('a reply to an album photo takes that album and its neighbours, not what came after the word', async () => {
  const photos = [...ALBUM_AND_SINGLES, photo(101, -1)];
  const { calls, deps, job } = harness({ photos, message: { reply_to_message: { message_id: 11 } } });
  await produceReport(job, deps);
  assert.deepEqual(calls.built[0].pages.length, 5, 'the photo after the word (101) is not in it');
});

test('61 photos are two PDFs, "Part 1 of 2"; a second part that fails leaves the first part marked, no 👍', async () => {
  const many = Array.from({ length: 61 }, (_, i) => photo(20 + i, 60 - i * 0.5));
  const ok = harness({ photos: many, message: { message_id: 500 } });
  await produceReport(ok.job, ok.deps);
  const docs = ok.telegram.log.filter((e) => e.method === 'sendDocument');
  assert.deepEqual(docs.map((d) => d.payload.document.filename), [
    'outbound_1_2026-11-06_part1of2.pdf', 'outbound_1_2026-11-06_part2of2.pdf',
  ]);
  assert.deepEqual(ok.calls.built.map((b) => b.pages.length), [60, 1]);
  assert.ok(ok.calls.built[1].coverLines.some((l) => l.text === 'Part 2 of 2 (photos 61-61)'));
  assert.equal(ok.calls.finish.at(-1).parts, 2);

  const half = harness({ photos: many, message: { message_id: 500 }, telegram: { refuseDocument: (n) => n === 2 } });
  const out = await produceReport(half.job, half.deps);
  assert.equal(out.status, 'failed');
  assert.equal(reactions(half.telegram).length, 0);
  assert.equal(half.calls.marked.length, 60, 'the 60 that went out are not sent again');
  assert.match(half.telegram.log.find((e) => e.method === 'sendMessage').text, /Part 2 of 2 could not be sent/);
});

test('at most 240 photos in one hand-over: the latest are kept, and the cover says how many were left out', async () => {
  const lots = Array.from({ length: 250 }, (_, i) => photo(20 + i, 170 - i * 0.5));
  const { calls, deps, job } = harness({ photos: lots, message: { message_id: 900 } });
  await produceReport(job, deps);
  assert.deepEqual(calls.built.map((b) => b.pages.length), [60, 60, 60, 60]);
  assert.equal(calls.marked[0], (20 + 10) * 10, 'the ten earliest were left out');
  assert.ok(calls.built[0].coverLines.some((l) => l.text === '10 earlier photos left out (too many for one hand-over)'));
  assert.match(calls.finish.at(-1).reason, /10 earlier photo\(s\) were left out/);
});

test('an inbound PDF names the outbound before it', async () => {
  const { calls, deps, job } = harness({
    trigger: { kind: 'inbound', bare: true }, message: { text: 'inbound' },
    outbound: { at: new Date('2026-10-28T14:00:00Z'), photoCount: 38 },
  });
  await produceReport(job, deps);
  assert.ok(calls.built[0].coverLines.some((l) => l.text === 'Outbound on Oct 28, 2026, 38 photos'));
});

test('switched off between the word and the report: closed, and nothing is sent', async () => {
  const { telegram, calls, deps, job } = harness({ settings: { enabled: false } });
  const out = await produceReport(job, deps);
  assert.equal(out.skipped, true);
  assert.equal(calls.finish[0].status, 'failed');
  assert.deepEqual(telegram.log, []);
});

test('an unexpected failure is recorded in the run ledger, closes the claim and tells the recipient', async () => {
  const { telegram, calls, deps, job } = harness();
  deps.listPhotosSince = async () => { throw new Error('connection reset'); };
  const keys = [];
  deps.runLedger = { withRunRecord: async (key, pass) => { keys.push(key); return pass(); } };
  const out = await runTruckPhotoReport(job, deps);
  assert.deepEqual(keys, ['truck_photo_reports']);
  assert.match(out.error, /connection reset/);
  assert.equal(calls.finish[0].status, 'failed');
  assert.equal(telegram.log.filter((e) => e.method === 'sendMessage' && e.chat === RECIPIENT).length, 1);
  assert.deepEqual(groupWrites(telegram), []);
});
