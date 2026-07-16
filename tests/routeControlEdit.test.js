/**
 * updateDriverGroupRouteMessage — in-place Telegram edits. Core behavior:
 * replacing a photo, editing text/captions, converting a text-only message to a
 * photo on the SAME message id, and the limits Telegram imposes. Nothing here
 * may ever send a new message.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadServiceWith } = require('./helpers/routeControlHarness');
const {
  loadServiceForEdit, EDIT_BASE, PNG, telegramErr,
} = require('./helpers/routeControlEditHarness');

test('update: replace screenshot on a single photo message edits the media in place', async () => {
  const { svc, telegram, captured } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: true, driver_group_message_via: 'photo', driver_group_messages: [{ message_id: 71, kind: 'photo' }] },
    screenshot: PNG,
  });
  const res = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram });
  assert.equal(res.code, 'UPDATED');
  assert.equal(res.screenshotUpdated, true);
  assert.equal(captured.edits.length, 1);
  assert.equal(captured.edits[0].kind, 'media');
  assert.equal(captured.edits[0].messageId, 71);
  assert.equal(captured.recordedEdit.opts.screenshotError, null, 'screenshot now shown → error cleared');
});

test('update: photo+text delivery edits BOTH the photo media and the text message', async () => {
  const { svc, telegram, captured } = loadServiceForEdit({
    assignment: {
      ...EDIT_BASE, has_screenshot: true, driver_group_message_via: 'photo+text',
      driver_group_messages: [{ message_id: 71, kind: 'photo' }, { message_id: 72, kind: 'text' }],
    },
    screenshot: PNG,
  });
  const res = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram, customMessage: 'updated route text' });
  assert.equal(res.code, 'UPDATED');
  assert.equal(res.screenshotUpdated, true);
  assert.equal(res.textUpdated, true);
  const media = captured.edits.find((e) => e.kind === 'media');
  const text = captured.edits.find((e) => e.kind === 'text');
  assert.equal(media.messageId, 71);
  assert.equal(text.messageId, 72);
  assert.match(text.a, /updated route text/);
});

test('update: text-only message edit changes the text in place', async () => {
  const { svc, telegram, captured } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: false, driver_group_message_via: 'text', driver_group_messages: [{ message_id: 72, kind: 'text' }] },
    screenshot: null,
  });
  const res = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram, customMessage: 'new text' });
  assert.equal(res.code, 'UPDATED');
  assert.equal(res.textUpdated, true);
  assert.equal(captured.edits.length, 1);
  assert.equal(captured.edits[0].kind, 'text');
  assert.equal(captured.edits[0].messageId, 72);
});

test('update: adding a screenshot to a text-only delivery CONVERTS it to a photo in place (Bot API 7.11+)', async () => {
  const { svc, telegram, captured } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: true, driver_group_message_via: 'text', driver_group_messages: [{ message_id: 72, kind: 'text' }] },
    screenshot: PNG,
  });
  const res = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram, customMessage: 'route body' });
  assert.equal(res.code, 'UPDATED');
  assert.equal(res.converted, true);
  assert.equal(res.conversion, 'text_to_photo');
  assert.equal(res.screenshotUpdated, true);
  assert.equal(res.textUpdated, true, 'the body becomes the photo caption');
  // editMessageMedia was called on the EXISTING text message id — no new message.
  assert.equal(captured.edits.length, 1);
  assert.equal(captured.edits[0].kind, 'media');
  assert.equal(captured.edits[0].messageId, 72);
  assert.equal(captured.edits[0].a.type, 'photo');
  assert.equal(captured.edits[0].a.caption, 'route body');
  // Metadata persisted so later replacements follow the photo branch.
  assert.equal(captured.recordedEdit.opts.via, 'photo');
  assert.deepEqual(captured.recordedEdit.opts.messages, [{ message_id: 72, kind: 'photo' }]);
  assert.equal(captured.recordedEdit.opts.screenshotError, null);
  assert.equal(captured.recordedEdit.opts.editError, null);
});

test('update: NO send/delete methods are used during a text→photo conversion', async () => {
  let forbidden = 0;
  const { svc, telegram } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: true, driver_group_message_via: 'text', driver_group_messages: [{ message_id: 72, kind: 'text' }] },
    screenshot: PNG,
  });
  telegram.sendPhoto = async () => { forbidden += 1; return { message_id: 999 }; };
  telegram.sendMessage = async () => { forbidden += 1; return { message_id: 999 }; };
  telegram.deleteMessage = async () => { forbidden += 1; };
  await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram });
  assert.equal(forbidden, 0, 'conversion must not send or delete any message');
});

test('update: legacy scalar-only text record converts on the same message id', async () => {
  const { svc, telegram, captured } = loadServiceForEdit({
    // No driver_group_messages list at all — only the legacy scalar id + via.
    assignment: { ...EDIT_BASE, has_screenshot: true, driver_group_message_via: 'text', driver_group_message_id: 555, driver_group_messages: null },
    screenshot: PNG,
  });
  const res = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram });
  assert.equal(res.converted, true);
  assert.equal(captured.edits[0].kind, 'media');
  assert.equal(captured.edits[0].messageId, 555, 'edited the legacy-tracked id — no new message');
  assert.deepEqual(captured.recordedEdit.opts.messages, [{ message_id: 555, kind: 'photo' }]);
});

test('update: JSON-STRING message list is parsed and converted', async () => {
  const { svc, telegram, captured } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: true, driver_group_message_via: 'text', driver_group_messages: JSON.stringify([{ message_id: 88, kind: 'text' }]) },
    screenshot: PNG,
  });
  const res = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram });
  assert.equal(res.converted, true);
  assert.equal(captured.edits[0].messageId, 88);
});

test('update: after conversion, a later replacement uses the photo branch on the same id', async () => {
  // The row now looks like a photo delivery (as persisted by the conversion).
  const { svc, telegram, captured } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: true, driver_group_message_via: 'photo', driver_group_messages: [{ message_id: 72, kind: 'photo' }] },
    screenshot: { file_data: Buffer.from('NEW-PNG'), mime_type: 'image/png' },
  });
  const res = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram });
  assert.equal(res.code, 'UPDATED');
  assert.equal(res.converted, false, 'already a photo — not a conversion');
  assert.equal(res.conversion, 'photo_replace');
  assert.equal(captured.edits[0].kind, 'media');
  assert.equal(captured.edits[0].messageId, 72);
});

test('update: overlong route text declines the conversion (no truncation, no new message)', async () => {
  const longBody = 'x'.repeat(1100); // > 1024 caption limit after entity parsing
  const { svc, telegram, captured } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: true, driver_group_message_via: 'text', driver_group_messages: [{ message_id: 72, kind: 'text' }] },
    screenshot: PNG,
  });
  const res = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram, customMessage: longBody });
  assert.equal(res.code, 'CAPTION_TOO_LONG_FOR_IN_PLACE_CONVERSION');
  assert.equal(res.screenshotUpdated, false);
  assert.equal(res.converted, false);
  assert.equal(captured.edits.length, 0, 'no Telegram mutation at all');
  assert.equal(captured.recordedEdit.opts.via, undefined, 'delivery type left unchanged');
  assert.equal(captured.recordedEdit.opts.messages, undefined, 'message list left unchanged');
  assert.equal(captured.recordedEdit.opts.screenshotError, 'CAPTION_TOO_LONG_FOR_IN_PLACE_CONVERSION');
});

test('update: a rejected conversion leaves the delivery as TEXT and reports the classified error', async () => {
  const { svc, telegram, captured } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: true, driver_group_message_via: 'text', driver_group_messages: [{ message_id: 72, kind: 'text' }] },
    screenshot: PNG,
    editImpl: { media: () => { throw telegramErr(400, 'Bad Request: message to edit not found'); } },
  });
  const res = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram });
  assert.equal(res.converted, false);
  assert.equal(res.updated, false);
  assert.equal(res.code, 'MESSAGE_NOT_FOUND');
  assert.equal(captured.recordedEdit.opts.via, undefined, 'metadata NOT converted on failure');
  assert.equal(captured.recordedEdit.opts.messages, undefined);
  assert.equal(captured.recordedEdit.opts.screenshotError, 'MESSAGE_NOT_FOUND');
});
test('update: removing a screenshot from a photo message cannot strip the image in place', async () => {
  const { svc, telegram, captured } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: false, driver_group_message_via: 'photo', driver_group_messages: [{ message_id: 71, kind: 'photo' }] },
    screenshot: null,
  });
  const res = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram });
  assert.ok(res.limitations.includes('PHOTO_IMAGE_CANNOT_BE_REMOVED_IN_PLACE'));
  assert.equal(res.screenshotRemovedInTelegram, false);
  assert.equal(captured.recordedEdit.opts.screenshotError, 'SCREENSHOT_STILL_SHOWN_IN_TELEGRAM');
  // It edits the caption (keeps text current) but never posts/deletes anything.
  assert.equal(captured.edits.some((e) => e.kind === 'caption'), true);
});

test('update: never sent → NO_SENT_MESSAGE, nothing edited or sent', async () => {
  const { svc, telegram, captured } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, driver_group_message_sent_at: null, driver_group_messages: null, driver_group_message_id: null },
  });
  const res = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram });
  assert.equal(res.code, 'NO_SENT_MESSAGE');
  assert.equal(captured.edits.length, 0);
});

test('update: sent earlier but no editable message id on file → NO_SENT_MESSAGE with guidance', async () => {
  const { svc, telegram } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, driver_group_messages: null, driver_group_message_id: null },
  });
  const res = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram });
  assert.equal(res.code, 'NO_SENT_MESSAGE');
  assert.match(res.detail, /no editable Telegram message id/i);
});

test('update: reconstructs legacy scalar id (via=photo) when no message list exists', async () => {
  const { svc, telegram, captured } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: true, driver_group_message_via: 'photo', driver_group_message_id: 555, driver_group_messages: null },
    screenshot: PNG,
  });
  const res = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram });
  assert.equal(res.screenshotUpdated, true);
  assert.equal(captured.edits[0].kind, 'media');
  assert.equal(captured.edits[0].messageId, 555, 'edited the legacy-tracked message id — restart-safe');
});

test('update: driver_group_messages stored as a JSON STRING is parsed (restart-safe)', async () => {
  const { svc, telegram, captured } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: false, driver_group_message_via: 'text', driver_group_messages: JSON.stringify([{ message_id: 88, kind: 'text' }]) },
    screenshot: null,
  });
  await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram, customMessage: 'x' });
  assert.equal(captured.edits[0].messageId, 88);
});

test('update: Telegram edit failure is reported truthfully, not as success', async () => {
  const { svc, telegram, captured } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: true, driver_group_message_via: 'photo', driver_group_messages: [{ message_id: 71, kind: 'photo' }] },
    screenshot: PNG,
    editImpl: { media: () => { throw telegramErr(400, 'Bad Request: MEDIA_INVALID'); } },
  });
  const res = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram });
  assert.equal(res.updated, false);
  assert.equal(res.screenshotUpdated, false);
  assert.match(res.code, /TELEGRAM_EDIT_REJECTED/);
  assert.ok(res.editError, 'edit error captured');
  assert.ok(captured.recordedEdit.opts.editError, 'edit failure persisted for the admin list');
});

test('update: message no longer found is classified', async () => {
  const { svc, telegram } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: false, driver_group_message_via: 'text', driver_group_messages: [{ message_id: 72, kind: 'text' }] },
    editImpl: { text: () => { throw telegramErr(400, 'Bad Request: message to edit not found'); } },
  });
  const res = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram, customMessage: 'x' });
  assert.equal(res.code, 'MESSAGE_NOT_FOUND');
});

test('update: bot permission failure (403) is classified', async () => {
  const { svc, telegram } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: false, driver_group_message_via: 'text', driver_group_messages: [{ message_id: 72, kind: 'text' }] },
    editImpl: { text: () => { throw telegramErr(403, 'Forbidden: not enough rights'); } },
  });
  const res = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram, customMessage: 'x' });
  assert.equal(res.code, 'BOT_PERMISSION');
});

test('update: "message can\'t be edited" is classified as not editable', async () => {
  const { svc, telegram } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: false, driver_group_message_via: 'text', driver_group_messages: [{ message_id: 72, kind: 'text' }] },
    editImpl: { text: () => { throw telegramErr(400, "Bad Request: message can't be edited"); } },
  });
  const res = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram, customMessage: 'x' });
  assert.equal(res.code, 'MESSAGE_NOT_EDITABLE');
});

test('update: first-attempt "message is not modified" = success worded as ALREADY UP TO DATE (not "updated")', async () => {
  const { svc, telegram } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: false, driver_group_message_via: 'text', driver_group_messages: [{ message_id: 72, kind: 'text' }] },
    editImpl: { text: () => { throw telegramErr(400, 'Bad Request: message is not modified'); } },
  });
  const res = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram, customMessage: 'x' });
  assert.equal(res.ok, true, 'no false failure');
  assert.equal(res.status, 'no_change');
  assert.equal(res.code, 'NO_CHANGE');
  assert.equal(res.alreadyUpToDate, true);
  assert.match(res.detail, /already up to date/i);
  assert.doesNotMatch(res.detail, /was updated/i, 'must not claim a change was made');
});

test('update: repeated replacements keep editing the SAME message id', async () => {
  const { svc, telegram, captured } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: true, driver_group_message_via: 'photo', driver_group_messages: [{ message_id: 71, kind: 'photo' }] },
    screenshot: PNG,
  });
  await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram });
  await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram });
  assert.equal(captured.edits.length, 2);
  assert.ok(captured.edits.every((e) => e.messageId === 71 && e.kind === 'media'));
});

test('update: near-simultaneous requests do not double-edit (in-flight guard)', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { svc, telegram, captured } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: false, driver_group_message_via: 'text', driver_group_messages: [{ message_id: 72, kind: 'text' }] },
    editImpl: { text: async () => { await gate; return { message_id: 72 }; } },
  });
  const p1 = svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram, customMessage: 'x' });
  // Let p1 progress past the in-flight guard and park inside editMessageText.
  await new Promise((r) => setImmediate(r));
  const r2 = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram, customMessage: 'x' });
  assert.equal(r2.code, 'EDIT_IN_PROGRESS', 'second concurrent request is rejected, not double-edited');
  release();
  const r1 = await p1;
  assert.equal(r1.code, 'UPDATED');
  assert.equal(captured.edits.length, 1, 'only one edit actually happened');
});
