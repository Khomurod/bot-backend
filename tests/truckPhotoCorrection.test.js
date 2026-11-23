'use strict';

/**
 * services/truckPhotos/correction.js — a person answers a hand-over PDF and
 * Wenze rebuilds it at once (the owner, 23 November 2026):
 *   - only the recipient and the listed people; anybody else is told so in
 *     private and ignored in a group;
 *   - in a driver group: reactions only, words go privately, the PDF to the
 *     recipient; nothing is ever written in the group;
 *   - not understood or no model: asked back, nothing changed; the question is
 *     remembered so a reply to it is a correction too;
 *   - a new truck number the profile does not say: ONE Yes / No, about the profile.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { takeCorrection } = require('../services/truckPhotos/correction');
const { RECIPIENT, GROUP_CHAT, fakes } = require('./helpers/truckPhotoCorrectionHarness');

const privately = (over = {}) => ({
  source: 'private', chatId: RECIPIENT, messageId: 50, replyToMessageId: 901, text: 'the truck number is 027 not 088',
  fromId: RECIPIENT, fromName: 'Tom Robinson', telegram: {}, ...over,
});
const inGroup = (over = {}) => ({
  source: 'group', chatId: GROUP_CHAT, messageId: 120, replyToMessageId: 100, text: 'truck is 027',
  fromId: '4444', fromName: 'Kim Rowe', telegram: {}, ...over,
});

test('the recipient\'s reply: read, rebuilt at once as a reply to them, 👀 then 👍, and ONE question about the profile', async () => {
  const { calls, deps } = fakes();
  const out = await takeCorrection(privately(), deps);
  assert.equal(out.handled, true);
  assert.equal((await out.done).status, 'sent');
  assert.equal(calls.read.text, 'the truck number is 027 not 088');
  assert.equal(calls.read.pdf.unit, '027', 'the cover the person saw: the chat title\'s number');
  assert.equal(calls.sent[0].replyTo, 50);
  assert.deepEqual(calls.saved[0].edits, { unit: '027', unitBy: 'Tom Robinson' });
  assert.deepEqual(calls.reactions, [[RECIPIENT, 50, '👀'], [RECIPIENT, 50, '👍']]);
  const question = calls.told.at(-1);
  assert.equal(question.recipient, RECIPIENT);
  assert.match(question.text, /^Also change the truck number in the profile of "WENZE UNIT # 027 FRANTZ ARTHUS" from 088 to 027\?/);
  assert.deepEqual(question.replyMarkup.inline_keyboard[0].map((b) => b.callback_data), ['tpu:y:9:088:027', 'tpu:n:9:088:027']);
});

test('an answer to an OLDER PDF: "photo 2" is photo 2 of the PDF they answered; the rebuild starts from the newest', async () => {
  const { itemsV1 } = require('./helpers/truckPhotoCorrectionHarness');
  const asked = [];
  const { calls, deps } = fakes({
    report: { version: 2 },
    found: { report: { id: 9, version: 2 }, version: 1, part: 1 },
    read: { status: 'ok', actions: [{ do: 'remove', photos: ['P2'] }] },
    deps: {
      listItems: async (id, version) => {
        asked.push(version);
        // version 2 dropped photo 2 already; in version 1, P2 was photo 2.
        return version === 1 ? itemsV1() : itemsV1().filter((i) => i.photo.id !== 2).map((i) => (i.photo.id === 3 ? { ...i, position: 2 } : i));
      },
    },
  });
  await (await takeCorrection(privately({ text: 'remove photo 2' }), deps)).done;
  assert.deepEqual(asked, [2, 1]);
  assert.deepEqual(calls.saved[0].edits.removed, [2], 'P2 of version 1 is photo 2, not photo 3');
  assert.equal(calls.saved[0].fromVersion, 2);
});

test('no question about the profile when it already says that number, or the answer named no number', async () => {
  const same = fakes({ profile: { unit_number: '027' } });
  await (await takeCorrection(privately(), same.deps)).done;
  assert.equal(same.calls.told.length, 0);
  const removing = fakes({ read: { status: 'ok', actions: [{ do: 'remove', photos: ['P2'] }] } });
  await (await takeCorrection(privately({ text: 'remove photo 2' }), removing.deps)).done;
  assert.equal(removing.calls.told.length, 0);
  assert.deepEqual(removing.calls.saved[0].edits, { removed: [2], restored: [] });
});

test('not understood: asked back under their message, nothing changed, and the question remembered', async () => {
  const { calls, deps } = fakes({ read: { status: 'unclear', question: 'Which photos should go?' } });
  const result = await (await takeCorrection(privately({ text: 'fix it' }), deps)).done;
  assert.equal(result.status, 'unclear');
  assert.equal(calls.saved.length, 0);
  assert.equal(calls.sent.length, 0);
  assert.match(calls.told[0].text, /^I am not sure what to change: Which photos should go\?/);
  assert.equal(calls.told[0].replyTo, 50);
  assert.deepEqual(calls.recordedMessages[0].messages, [{ chatId: RECIPIENT, messageId: 901, part: 0 }]);
  assert.deepEqual(calls.reactions.at(-1), [RECIPIENT, 50, '🤷']);
});

test('no model: nothing changed, and said so', async () => {
  const { calls, deps } = fakes({ read: { status: 'unavailable' } });
  await (await takeCorrection(privately(), deps)).done;
  assert.match(calls.told[0].text, /No AI model could read your answer right now/);
  assert.equal(calls.saved.length, 0);
});

test('"not a hand-over": cancelled, said so', async () => {
  const { calls, deps } = fakes({ read: { status: 'ok', actions: [{ do: 'cancel' }] } });
  await (await takeCorrection(privately({ text: 'this is not a handover' }), deps)).done;
  assert.equal(calls.saved[0].status, 'cancelled');
  assert.match(calls.told[0].text, /^Done: the OUTBOUND in "WENZE UNIT # 027 FRANTZ ARTHUS" is no longer on record/);
});

test('someone not listed, in private: told who may; switched off: told so; neither is read', async () => {
  const stranger = fakes();
  const out = await takeCorrection(privately({ chatId: '9999', fromId: '9999' }), stranger.deps);
  assert.equal(out.handled, true);
  assert.match(stranger.calls.told[0].text, /^Only the person who receives the truck photo PDFs/);
  assert.equal(stranger.calls.read, undefined);

  const off = fakes({ settings: { enabled: false } });
  await takeCorrection(privately(), off.deps);
  assert.match(off.calls.told[0].text, /switched off/);
  assert.equal(off.calls.read, undefined);
});

test('a reply in private to a message that is not ours goes on untouched', async () => {
  const { calls, deps } = fakes({ found: null });
  assert.deepEqual(await takeCorrection(privately(), deps), { handled: false });
  assert.equal(calls.told.length, 0);
});

test('in the driver group: a listed person\'s tag is read, reactions only, the PDF to the recipient under its last PDF', async () => {
  const { calls, deps } = fakes();
  const out = await takeCorrection(inGroup(), deps);
  await out.done;
  assert.deepEqual(calls.reactions, [[GROUP_CHAT, 120, '👀'], [GROUP_CHAT, 120, '👍']]);
  assert.equal(calls.sent[0].recipient, RECIPIENT);
  assert.equal(calls.sent[0].replyTo, 555, 'under the newest PDF in the recipient\'s chat');
  assert.ok(calls.told.every((t) => t.recipient !== GROUP_CHAT), 'nothing written in the group');
  assert.equal(calls.told.at(-1).recipient, '4444', 'the profile question goes to the person, privately');
});

test('in the driver group: the question goes to the recipient when the person never pressed Start', async () => {
  const { calls, deps } = fakes({ refuseTell: (args) => args.recipient === '4444' });
  await (await takeCorrection(inGroup(), deps)).done;
  assert.deepEqual(calls.told.map((t) => t.recipient), ['4444', RECIPIENT]);
});

test('in the driver group: a person not listed, or a word with no report, is ignored — not even a reaction', async () => {
  const stranger = fakes();
  assert.deepEqual(await takeCorrection(inGroup({ fromId: '9999' }), stranger.deps), { handled: false });
  assert.deepEqual(stranger.calls.reactions, []);
  const unknown = fakes({ byTrigger: null });
  assert.deepEqual(await takeCorrection(inGroup(), unknown.deps), { handled: false });
});
