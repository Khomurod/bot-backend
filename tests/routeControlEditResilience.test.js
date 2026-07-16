/**
 * updateDriverGroupRouteMessage — transient network resilience for the
 * text→photo conversion (prod bug 22): bounded retries on the SAME message id,
 * genuinely ABORTED per-attempt timeouts, ambiguous ("unconfirmed") outcomes,
 * and the rule that delivery metadata changes only after a CONFIRMED conversion.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadServiceForEdit, EDIT_BASE, PNG, telegramErr, noRetryWait, socketHangUp,
} = require('./helpers/routeControlEditHarness');

test('update: socket hang up on the conversion is retried and succeeds — metadata persisted, no new message', async () => {
  let calls = 0;
  const { svc, telegram, captured } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: true, driver_group_message_via: 'text', driver_group_messages: [{ message_id: 1410, kind: 'text' }] },
    screenshot: PNG,
    editImpl: { media: () => { calls += 1; if (calls === 1) throw socketHangUp(); return { message_id: 1410 }; } },
  });
  telegram.sendPhoto = () => { throw new Error('must not send'); };
  telegram.sendMessage = () => { throw new Error('must not send'); };
  const res = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram, retry: noRetryWait });
  assert.equal(res.ok, true);
  assert.equal(res.status, 'updated');
  assert.equal(res.converted, true);
  assert.equal(res.attempts, 2);
  assert.equal(calls, 2, 'edited the SAME message id twice — retried in place, never a new message');
  assert.equal(captured.recordedEdit.opts.via, 'photo', 'metadata persisted only after confirmed success');
  assert.deepEqual(captured.recordedEdit.opts.messages, [{ message_id: 1410, kind: 'photo' }]);
});

test('update: three socket hang ups → UNCONFIRMED (ambiguous), metadata unchanged, no new message', async () => {
  let calls = 0;
  const { svc, telegram, captured } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: true, driver_group_message_via: 'text', driver_group_messages: [{ message_id: 1410, kind: 'text' }] },
    screenshot: PNG,
    editImpl: { media: () => { calls += 1; throw socketHangUp(); } },
  });
  const res = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram, retry: noRetryWait });
  assert.equal(calls, 3);
  assert.equal(res.ok, false);
  assert.equal(res.status, 'unconfirmed');
  assert.equal(res.ambiguousOutcome, true);
  assert.equal(res.code, 'TELEGRAM_CONNECTION_RESET');
  assert.equal(res.category, 'transport');
  assert.equal(res.transportCode, 'ECONNRESET');
  assert.equal(res.attempts, 3);
  assert.equal(res.operation, 'edit_media_text_to_photo');
  assert.match(res.detail, /could not be confirmed after 3 attempts/i);
  assert.ok(res.correlationId && res.correlationId.startsWith('rc-edit-'));
  // Delivery metadata must NOT be marked converted on an unconfirmed outcome.
  assert.equal(captured.recordedEdit.opts.via, undefined);
  assert.equal(captured.recordedEdit.opts.messages, undefined);
});

test('update: lost response then "message is not modified" on retry → confirmed success', async () => {
  let calls = 0;
  const { svc, telegram, captured } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: true, driver_group_message_via: 'text', driver_group_messages: [{ message_id: 1410, kind: 'text' }] },
    screenshot: PNG,
    editImpl: {
      media: () => {
        calls += 1;
        if (calls === 1) throw socketHangUp();
        throw telegramErr(400, 'Bad Request: message is not modified');
      },
    },
  });
  const res = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram, retry: noRetryWait });
  assert.equal(res.ok, true);
  assert.equal(res.converted, true, 'the earlier request had applied — treated as success');
  assert.equal(res.attempts, 2);
  assert.equal(captured.recordedEdit.opts.via, 'photo');
});

test('update: transport failure exposes safe structured fields with no secrets', async () => {
  const { svc, telegram } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: true, driver_group_message_via: 'text', driver_group_messages: [{ message_id: 1410, kind: 'text' }] },
    screenshot: PNG,
    editImpl: { media: () => { throw Object.assign(new Error('write EPROTO https://api.telegram.org/bot123:SECRET/x'), { code: 'ECONNRESET' }); } },
  });
  const res = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram, retry: noRetryWait });
  const blob = JSON.stringify(res);
  assert.doesNotMatch(blob, /SECRET/);
  assert.doesNotMatch(blob, /bot123:/);
  assert.doesNotMatch(blob, /api\.telegram\.org/);
});

test('update: conversion goes through RAW callApi with a real AbortSignal and a Buffer photo source', async () => {
  const { svc, telegram, captured } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: true, driver_group_message_via: 'text', driver_group_messages: [{ message_id: 1410, kind: 'text' }] },
    screenshot: PNG,
  });
  const res = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram, retry: noRetryWait });
  assert.equal(res.converted, true);
  const media = captured.edits.find((e) => e.kind === 'media');
  assert.equal(media.via, 'callApi', 'raw Bot API call, not the wrapper');
  assert.equal(media.method, 'editMessageMedia');
  assert.equal(media.signal, true, 'a per-attempt AbortSignal reached the HTTP layer');
  assert.equal(media.messageId, 1410, 'same message id — never a new message');
  assert.equal(media.payload.inline_message_id, undefined, 'inline_message_id never set for a chat message');
  assert.ok(Buffer.isBuffer(media.a.media.source), 'stored screenshot is a Buffer Telegraf can upload');
});

test('update: conversion never calls sendMessage, sendPhoto, deleteMessage, or copyMessage', async () => {
  let forbidden = 0;
  const { svc, telegram } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: true, driver_group_message_via: 'text', driver_group_messages: [{ message_id: 1410, kind: 'text' }] },
    screenshot: PNG,
  });
  telegram.sendPhoto = async () => { forbidden += 1; return { message_id: 999 }; };
  telegram.sendMessage = async () => { forbidden += 1; return { message_id: 999 }; };
  telegram.deleteMessage = async () => { forbidden += 1; };
  telegram.copyMessage = async () => { forbidden += 1; return { message_id: 999 }; };
  const res = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram, retry: noRetryWait });
  assert.equal(res.converted, true);
  assert.equal(forbidden, 0, 'no send/delete/copy of any kind during an in-place update');
});

test('update: three ABORTED timeouts on the conversion → unconfirmed, metadata unchanged, requests all settled', async () => {
  let active = 0;
  let maxActive = 0;
  const { svc, telegram, captured } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: true, driver_group_message_via: 'text', driver_group_messages: [{ message_id: 1410, kind: 'text' }] },
    screenshot: PNG,
    // A stalled multipart upload that only settles when OUR AbortSignal fires —
    // the exact production failure shape (30s ETIMEDOUT, no Telegram response).
    editImpl: {
      media: (chat, msg, inline, mediaObj, opts) => new Promise((_res, reject) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        opts.signal.addEventListener('abort', () => {
          active -= 1;
          const e = new Error('The user aborted a request.');
          e.name = 'AbortError';
          e.type = 'aborted';
          reject(e);
        }, { once: true });
      }),
    },
  });
  const res = await svc.updateDriverGroupRouteMessage({
    assignmentId: 9, telegram, retry: { ...noRetryWait, perAttemptTimeoutMs: 15 },
  });
  assert.equal(res.ok, false);
  assert.equal(res.status, 'unconfirmed');
  assert.equal(res.code, 'TELEGRAM_TIMEOUT');
  assert.equal(res.attempts, 3);
  assert.equal(res.abortedAttempts, 3, 'every timed-out request was actually aborted');
  assert.equal(res.ambiguousOutcome, true);
  assert.equal(maxActive, 1, 'attempts never overlapped');
  assert.equal(active, 0, 'no request left running');
  assert.equal(captured.recordedEdit.opts.via, undefined, 'metadata NOT converted on an unconfirmed outcome');
  assert.equal(captured.recordedEdit.opts.messages, undefined);
});

test('update: first-attempt not-modified CONVERSION reports already-up-to-date and persists truthful photo metadata', async () => {
  const { svc, telegram, captured } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: true, driver_group_message_via: 'text', driver_group_messages: [{ message_id: 1410, kind: 'text' }] },
    screenshot: PNG,
    editImpl: { media: () => { throw telegramErr(400, 'Bad Request: message is not modified'); } },
  });
  const res = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram, retry: noRetryWait });
  assert.equal(res.ok, true);
  assert.equal(res.status, 'no_change');
  assert.match(res.detail, /already up to date/i);
  // The message in Telegram already IS this photo — record that truth.
  assert.equal(captured.recordedEdit.opts.via, 'photo');
  assert.deepEqual(captured.recordedEdit.opts.messages, [{ message_id: 1410, kind: 'photo' }]);
});
