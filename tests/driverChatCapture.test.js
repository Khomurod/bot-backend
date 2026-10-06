'use strict';

/**
 * Recording driver messages for the retention signals — only while the owner's
 * switch says so, only a person's text in a driver group, and never at the
 * cost of the message handler.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  captureDriverMessage, senderNameOf, MAX_TEXT, forgetStandings,
} = require('../services/retention/chatCapture');
const { runChatAnnotationPass } = require('../services/retention/chatAnnotator');

const GROUP = { id: 7, group_type: 'driver' };
const FROM = { id: 501, first_name: 'Test', last_name: 'Driver', is_bot: false };

function deps({ enabled = true, failWrite = false, standing = { source: 'group', driverGroupCount: 1 } } = {}) {
  forgetStandings();
  const written = [];
  return {
    written,
    deps: {
      settings: { async getChatCaptureSettings() { return { enabled }; } },
      standing: async () => {
        if (standing instanceof Error) throw standing;
        return standing;
      },
      logs: {
        async logChatMessage(...args) {
          if (failWrite) throw new Error('db down');
          written.push(args);
        },
      },
    },
  };
}

test('a driver message is recorded while capture is on', async () => {
  const { deps: d, written } = deps();
  const out = await captureDriverMessage({ group: GROUP, message: { text: 'I am quitting', message_id: 9 }, from: FROM }, d);
  assert.deepEqual(out, { recorded: true });
  assert.deepEqual(written[0], [7, 501, 'Test Driver', 'I am quitting', 9]);
});

test('captions count; text is clipped', async () => {
  const { deps: d, written } = deps();
  await captureDriverMessage({ group: GROUP, message: { caption: 'x'.repeat(MAX_TEXT + 50) }, from: FROM }, d);
  assert.equal(written[0][3].length, MAX_TEXT);
});

test('nothing is recorded when the owner switches it off', async () => {
  const { deps: d, written } = deps({ enabled: false });
  const out = await captureDriverMessage({ group: GROUP, message: { text: 'hi' }, from: FROM }, d);
  assert.equal(out.reason, 'capture_off');
  assert.equal(written.length, 0);
});

test('only a PERSON in a DRIVER group, and only text', async () => {
  const { deps: d, written } = deps();
  assert.equal((await captureDriverMessage({ group: { id: 1, group_type: 'company' }, message: { text: 'x' }, from: FROM }, d)).reason, 'not_a_driver_group');
  assert.equal((await captureDriverMessage({ group: GROUP, message: { text: 'x' }, from: { ...FROM, is_bot: true } }, d)).reason, 'not_a_person');
  assert.equal((await captureDriverMessage({ group: GROUP, message: { photo: [{}] }, from: FROM }, d)).reason, 'no_text');
  assert.equal(written.length, 0);
});

test('A DISPATCHER IS NOT THE DRIVER — staff messages are never recorded (review, #261)', async () => {
  for (const standing of [
    { source: 'dispatcher', driverGroupCount: 1 },
    { source: 'admin', driverGroupCount: 0 },
    { source: 'group', driverGroupCount: 3 },
  ]) {
    const { deps: d, written } = deps({ standing });
    const out = await captureDriverMessage({ group: GROUP, message: { text: 'this is unacceptable' }, from: FROM }, d);
    assert.equal(out.reason, 'staff', JSON.stringify(standing));
    assert.equal(written.length, 0);
  }
});

test('a standing that cannot be read is treated as staff — misattribution is worse than a gap', async () => {
  const { deps: d, written } = deps({ standing: new Error('db down') });
  const out = await captureDriverMessage({ group: GROUP, message: { text: 'x' }, from: FROM }, d);
  assert.equal(out.reason, 'staff');
  assert.equal(written.length, 0);
});

test('a failed write never throws into the message handler', async () => {
  const { deps: d } = deps({ failWrite: true });
  const out = await captureDriverMessage({ group: GROUP, message: { text: 'x' }, from: FROM }, d);
  assert.deepEqual(out, { recorded: false, reason: 'error' });
});

test('the sender is filed by name, falling back to the username', () => {
  assert.equal(senderNameOf({ username: 'td' }), '@td');
  assert.equal(senderNameOf(null), 'Unknown');
});

// ── the annotator ───────────────────────────────────────────────────────────

function annotatorDeps({ enabled = true, rows = [], annotated = rows.length } = {}) {
  const calls = { queries: 0, annotated: [] };
  return {
    calls,
    deps: {
      settings: { async getChatCaptureSettings() { return { enabled }; } },
      db: { async query() { calls.queries += 1; return { rows }; } },
      annotate: async (r) => { calls.annotated.push(r); return annotated; },
    },
  };
}

test('capture off: the annotator says BLOCKED and reads nothing', async () => {
  const { deps: d, calls } = annotatorDeps({ enabled: false });
  const out = await runChatAnnotationPass({ deps: d });
  assert.match(out.blocked, /switched off/);
  assert.equal(calls.queries, 0);
});

test('waiting messages are annotated', async () => {
  const { deps: d, calls } = annotatorDeps({ rows: [{ id: 1 }, { id: 2 }] });
  const out = await runChatAnnotationPass({ deps: d });
  assert.deepEqual(out, { found: 2, annotated: 2 });
  assert.equal(calls.annotated[0].length, 2);
});

test('messages waiting and NONE annotated is a failed pass, not a quiet one', async () => {
  const { deps: d } = annotatorDeps({ rows: [{ id: 1 }], annotated: 0 });
  const out = await runChatAnnotationPass({ deps: d });
  assert.match(out.error, /none of 1/);
});

test('AI switched off: BLOCKED, not a failed pass', async () => {
  const { deps: d, calls } = annotatorDeps({ rows: [{ id: 1 }] });
  d.isAiAvailable = async () => false;
  const out = await runChatAnnotationPass({ deps: d });
  assert.match(out.blocked, /AI is switched off/);
  assert.equal(calls.queries, 0);
});

test('nothing waiting is a clean pass that calls no model', async () => {
  const { deps: d, calls } = annotatorDeps({ rows: [] });
  assert.deepEqual(await runChatAnnotationPass({ deps: d }), { found: 0, annotated: 0 });
  assert.equal(calls.annotated.length, 0);
});

test('the message handler records driver messages', () => {
  // eslint-disable-next-line global-require
  const src = require('node:fs').readFileSync(require.resolve('../bot/handlers/groupCaptureHandlers.js'), 'utf8');
  assert.match(src, /captureDriverMessage\(\{ group, message: ctx\.message, from: ctx\.from \}\)/);
});

test('the annotator drains the OLDEST first, so a backlog is never overtaken (review, #261)', async () => {
  let sql = '';
  const out = await runChatAnnotationPass({
    deps: {
      settings: { async getChatCaptureSettings() { return { enabled: true }; } },
      db: { async query(text) { sql = text; return { rows: [] }; } },
      annotate: async () => 0,
    },
  });
  assert.deepEqual(out, { found: 0, annotated: 0 });
  assert.match(sql, /ORDER BY cl\.created_at ASC/);
});
