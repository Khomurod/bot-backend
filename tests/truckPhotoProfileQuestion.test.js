'use strict';

/**
 * services/truckPhotos/profileQuestion.js — the ONE Yes / No a PDF correction
 * asks: whether the driver's profile should say the corrected truck number
 * too. Yes applies `profile.set_unit` as that person (audited, refusing a
 * stale profile); No changes nothing; a button under an older correction, or
 * from somebody not listed, changes nothing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { handleProfileButton, profileQuestionFor, CALLBACK_PATTERN } = require('../services/truckPhotos/profileQuestion');

const deps = (over = {}) => {
  const applied = [];
  return {
    applied,
    getSettings: async () => ({ recipientTelegramId: '777000', editorTelegramIds: ['4444'] }),
    getReport: async () => ({ id: 9, groupId: 3, groupName: 'WENZE UNIT # 088 FRANTZ ARTHUS', edits: { unit: '027' }, ...over.report }),
    applyCorrection: async (args) => {
      applied.push(args);
      if (over.refuse) throw new Error("Group 3's profile now says unit 090, not 088.");
      return { id: 1 };
    },
  };
};

test('the question is asked only when the profile says another number it can carry', () => {
  const q = profileQuestionFor({ reportId: 9, profile: { unit_number: '088' }, to: '027' });
  assert.equal(q.from, '088');
  assert.ok(q.keyboard.inline_keyboard[0].every((b) => CALLBACK_PATTERN.test(b.callback_data)));
  assert.equal(profileQuestionFor({ reportId: 9, profile: { unit_number: '027' }, to: '027' }), null);
  assert.equal(profileQuestionFor({ reportId: 9, profile: { unit_number: '001A' }, to: '001' }), null, 'the same truck written in full');
  assert.equal(profileQuestionFor({ reportId: 9, profile: { unit_number: '1 / 2' }, to: '027' }), null);
  assert.match(profileQuestionFor({ reportId: 9, profile: {}, to: '027' }).keyboard.inline_keyboard[0][0].callback_data, /^tpu:y:9:-:027$/);
});

test('Yes: the profile is set by that person, through the registry, refusing a profile that changed', async () => {
  const d = deps();
  const out = await handleProfileButton({ data: 'tpu:y:9:088:027', telegramUserId: 777000 }, d);
  assert.deepEqual(d.applied.map((a) => [a.actionKey, a.payload, a.admin, a.markFinding]), [
    ['profile.set_unit', { groupId: 3, unitNumber: '027', from: '088' }, { telegramUserId: '777000' }, false],
  ]);
  assert.match(out.edit, /^Done: the profile of "WENZE UNIT # 088 FRANTZ ARTHUS" says unit 027 now\. The chat title still says 088, so rename the chat/);

  const stale = deps({ refuse: true });
  const refused = await handleProfileButton({ data: 'tpu:y:9:088:027', telegramUserId: 4444 }, stale);
  assert.match(refused.edit, /^Nothing changed: Group 3's profile now says unit 090/);
});

test('No changes nothing; an older correction\'s button, or a stranger\'s press, changes nothing', async () => {
  const d = deps();
  assert.match((await handleProfileButton({ data: 'tpu:n:9:088:027', telegramUserId: 777000 }, d)).edit, /^Left as it is: the profile still says unit 088\./);
  const older = deps({ report: { edits: { unit: '029' } } });
  assert.match((await handleProfileButton({ data: 'tpu:y:9:088:027', telegramUserId: 777000 }, older)).edit, /corrected again/);
  const stranger = deps();
  const out = await handleProfileButton({ data: 'tpu:y:9:088:027', telegramUserId: 1 }, stranger);
  assert.equal(out.alert, true);
  assert.equal(d.applied.length + older.applied.length + stranger.applied.length, 0);
  assert.equal((await handleProfileButton({ data: 'tpu:y:9:088:027; DROP', telegramUserId: 777000 }, d)).alert, true);
});
