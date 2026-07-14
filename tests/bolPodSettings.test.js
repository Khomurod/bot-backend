/**
 * Unit tests for the BOL/POD settings helper (validation + enable-guard) and the
 * central-group validation service. The db module is stubbed via require.cache
 * with a mutable single-row store; no database or network is used.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const dbPath = path.resolve(ROOT, 'database/db.js');

let settingsRow = null;
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    query: async (text) => {
      if (/FROM bol_pod_forwarding_settings/.test(text)) return { rows: settingsRow ? [settingsRow] : [] };
      return { rows: [] };
    },
  },
};

const bolPod = require(path.resolve(ROOT, 'database/bolPodForwardingSettings'));
const { validateGroup, sendTestMessage } = require(path.resolve(ROOT, 'services/bolPodGroupValidation'));

function setRow(overrides = {}) {
  settingsRow = {
    id: 1, enabled: false, delivery_mode: 'driver_group', central_group_id: null,
    central_group_title: null, central_group_validated_at: null,
    document_type_mode: 'both', uncertain_document_policy: 'do_not_send',
    last_tested_at: null, updated_by: null, updated_at: '2026-07-14T00:00:00Z', ...overrides,
  };
  bolPod.invalidateCache();
}

// ── Settings helper ──

test('defaults to disabled, driver_group, both, do_not_send when no row exists', async () => {
  settingsRow = null; bolPod.invalidateCache();
  const s = await bolPod.getBolPodSettingsForAdmin();
  assert.equal(s.enabled, false);
  assert.equal(s.deliveryMode, 'driver_group');
  assert.equal(s.documentTypeMode, 'both');
  assert.equal(s.uncertainDocumentPolicy, 'do_not_send');
  assert.equal(s.centralGroupConfigured, false);
  assert.equal(s.centralGroupValidated, false);
});

test('rejects an invalid delivery mode', async () => {
  setRow();
  await assert.rejects(() => bolPod.updateBolPodSettings({ deliveryMode: 'bogus' }), /Invalid delivery mode/);
});

test('rejects an invalid document-type mode', async () => {
  setRow();
  await assert.rejects(() => bolPod.updateBolPodSettings({ documentTypeMode: 'nope' }), /Invalid document type mode/);
});

test('rejects an invalid uncertain-document policy', async () => {
  setRow();
  await assert.rejects(() => bolPod.updateBolPodSettings({ uncertainDocumentPolicy: 'maybe' }), /uncertain-document policy/);
});

test('central-only mode cannot be enabled without a configured central group', async () => {
  setRow({ delivery_mode: 'central_group' });
  await assert.rejects(() => bolPod.updateBolPodSettings({ enabled: true, deliveryMode: 'central_group' }), /Configure a central group/);
});

test('both mode cannot be enabled without a validated central group', async () => {
  setRow({ delivery_mode: 'both', central_group_id: '-1002997837889', central_group_validated_at: null });
  await assert.rejects(() => bolPod.updateBolPodSettings({ enabled: true, deliveryMode: 'both' }), /Validate the central group/);
});

test('driver-only mode can be enabled without any central group', async () => {
  setRow();
  await assert.doesNotReject(() => bolPod.updateBolPodSettings({ enabled: true, deliveryMode: 'driver_group' }));
});

test('central mode can be enabled once the group is configured and validated', async () => {
  setRow({ delivery_mode: 'central_group', central_group_id: '-1002997837889', central_group_validated_at: '2026-07-14T00:00:00Z' });
  await assert.doesNotReject(() => bolPod.updateBolPodSettings({ enabled: true }));
});

test('an invalid central group id is rejected', async () => {
  setRow();
  await assert.rejects(() => bolPod.updateBolPodSettings({ centralGroupId: 'not-a-number' }), /numeric Telegram chat id/);
});

// ── Central-group validation service ──

function tg({ me = { id: 42 }, chat, member, sendErr } = {}) {
  return {
    getMe: async () => me,
    getChat: async () => { if (chat instanceof Error) throw chat; return chat; },
    getChatMember: async () => { if (member instanceof Error) throw member; return member; },
    sendMessage: async () => { if (sendErr) throw sendErr; return { message_id: 7 }; },
  };
}

test('validateGroup: valid supergroup where the bot is admin', async () => {
  const r = await validateGroup(tg({ chat: { type: 'supergroup', title: 'Ops Docs' }, member: { status: 'administrator' } }), '-1002997837889');
  assert.equal(r.ok, true);
  assert.equal(r.title, 'Ops Docs');
});

test('validateGroup: rejects a non-numeric id', async () => {
  const r = await validateGroup(tg(), 'abc');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid_format');
});

test('validateGroup: rejects a private (non-group) chat', async () => {
  const r = await validateGroup(tg({ chat: { type: 'private', title: null }, member: { status: 'member' } }), '12345');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'wrong_type');
});

test('validateGroup: rejects when the bot is not a member', async () => {
  const r = await validateGroup(tg({ chat: { type: 'supergroup', title: 'X' }, member: { status: 'left' } }), '-100123');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_member');
});

test('validateGroup: rejects when the bot is restricted from sending documents', async () => {
  const r = await validateGroup(tg({
    chat: { type: 'supergroup', title: 'X' },
    member: { status: 'restricted', can_send_documents: false, can_send_media_messages: false },
  }), '-100123');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'cannot_post');
});

test('validateGroup: a channel requires the bot to be an administrator', async () => {
  const r = await validateGroup(tg({ chat: { type: 'channel', title: 'Chan' }, member: { status: 'member' } }), '-100123');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'cannot_post');
});

test('validateGroup: the bot token never leaks into an error message', async () => {
  const err = new Error('failed https://api.telegram.org/bot123456:SECRET_TOKEN/getChat');
  const r = await validateGroup(tg({ chat: err }), '-100123');
  assert.equal(r.ok, false);
  assert.ok(!/SECRET_TOKEN/.test(r.message), 'token must be scrubbed from the message');
});

test('sendTestMessage: succeeds on a valid id and fails safe on error', async () => {
  const ok = await sendTestMessage(tg(), '-100123');
  assert.equal(ok.ok, true);
  const bad = await sendTestMessage(tg({ sendErr: new Error('nope') }), '-100123');
  assert.equal(bad.ok, false);
  const malformed = await sendTestMessage(tg(), 'abc');
  assert.equal(malformed.ok, false);
});
