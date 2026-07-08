/**
 * Tests for services/documentIntakeHelpers.js — attachment detection, ignore
 * rules (bot/self/forwarded-from-bot loop prevention, non-doc types),
 * authorization, and the confirmation message/keyboard/callback plumbing.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../services/documentIntakeHelpers');

test('detects a PDF document', () => {
  const a = h.detectAttachment({ document: { file_id: 'F1', file_unique_id: 'U1', mime_type: 'application/pdf', file_name: 'bol.pdf', file_size: 1000 } });
  assert.equal(a.kind, 'pdf');
  assert.equal(a.fileUniqueId, 'U1');
});

test('detects an image document by extension when mime is generic', () => {
  const a = h.detectAttachment({ document: { file_id: 'F2', file_unique_id: 'U2', mime_type: 'application/octet-stream', file_name: 'pod.JPG' } });
  assert.equal(a.kind, 'image');
});

test('detects a photo message (largest size)', () => {
  const a = h.detectAttachment({ photo: [
    { file_id: 'small', file_unique_id: 'us', file_size: 100 },
    { file_id: 'big', file_unique_id: 'ub', file_size: 9000 },
  ] });
  assert.equal(a.kind, 'image');
  assert.equal(a.fileId, 'big');
});

test('ignores video / voice / sticker (no photo/document field)', () => {
  assert.equal(h.detectAttachment({ video: { file_id: 'v' } }), null);
  assert.equal(h.detectAttachment({ voice: { file_id: 'v' } }), null);
  assert.equal(h.detectAttachment({ sticker: { file_id: 's' } }), null);
  assert.equal(h.detectAttachment({ document: { file_id: 'x', mime_type: 'video/mp4', file_name: 'clip.mp4' } }), null);
});

test('ignores the bot\'s own messages and any bot', () => {
  assert.equal(h.isIgnorableMessage({ from: { id: 42, is_bot: true } }).ignore, true);
  assert.equal(h.isIgnorableMessage({ from: { id: 999 } }, { selfBotId: 999 }).ignore, true);
});

test('ignores a document forwarded from a bot (loop prevention)', () => {
  const r = h.isIgnorableMessage({ from: { id: 5, is_bot: false }, forward_from: { id: 999, is_bot: true } });
  assert.equal(r.ignore, true);
  assert.match(r.reason, /forwarded from a bot/);
});

test('does NOT ignore a human forwarding a shipper document', () => {
  const r = h.isIgnorableMessage({ from: { id: 5, is_bot: false }, forward_from: { id: 7, is_bot: false } });
  assert.equal(r.ignore, false);
});

test('size limit gate', () => {
  assert.equal(h.sizeWithinLimit(1000, 2000), true);
  assert.equal(h.sizeWithinLimit(3000, 2000), false);
  assert.equal(h.sizeWithinLimit(null, 2000), true); // unknown until download
});

test('authorization: privileged admin allowed; random user rejected', () => {
  assert.equal(h.authorizeUploader({ id: 1 }, { privileged: true }).allowed, true);
  assert.equal(h.authorizeUploader({ id: 2, username: 'rando' }, { approvers: ['dispatch_lead'] }).allowed, false);
});

test('authorization: configured approver by username or id; group admin', () => {
  assert.equal(h.authorizeUploader({ id: 2, username: 'Dispatch_Lead' }, { approvers: ['dispatch_lead'] }).allowed, true);
  assert.equal(h.authorizeUploader({ id: 123 }, { approvers: ['123'] }).allowed, true);
  assert.equal(h.authorizeUploader({ id: 55 }, { groupAdminIds: [55, 66] }).allowed, true);
});

test('authorization: no user rejected', () => {
  assert.equal(h.authorizeUploader(null, { privileged: true }).allowed, false);
});

test('callback data round-trips through keyboard + parser', () => {
  const kb = h.buildConfirmationKeyboard(77);
  const yes = kb.inline_keyboard[0][0].callback_data;
  assert.equal(yes, 'dtdoc:yes:77');
  assert.deepEqual(h.parseCallbackData(yes), { action: 'yes', batchId: 77 });
  assert.deepEqual(h.parseCallbackData('dtdoc:disc:5'), { action: 'disc', batchId: 5 });
  assert.equal(h.parseCallbackData('garbage'), null);
  assert.equal(h.parseCallbackData('mbonus:paid:1'), null);
});

test('confirmation message shows test-mode banner in dry-run and escapes HTML', () => {
  const msg = h.buildConfirmationMessage({
    driverName: 'A & B <x>', docType: 'pod', loadReference: '9188060', matchConfidence: 'high',
    reason: 'delivery signature matched', fileCount: 2, dryRun: true,
  });
  assert.match(msg, /Test mode/i);
  assert.match(msg, /Load: <b>9188060<\/b>/);
  assert.match(msg, /A &amp; B &lt;x&gt;/); // escaped
  assert.match(msg, /merged into one PDF/);
});

test('confirmation message in live mode asks to upload', () => {
  const msg = h.buildConfirmationMessage({ driverName: 'Joe', docType: 'bol', matchConfidence: 'medium', dryRun: false });
  assert.match(msg, /Upload this BOL to Datatruck\?/);
});
