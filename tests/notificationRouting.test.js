/**
 * Where an operational notice goes, and what it is allowed to say.
 *
 * Two failures this guards against, both of which have already happened here in
 * one form or another: a notice going nowhere because a destination was blank
 * or subtly wrong (101 staff alerts were discarded for months that way), and a
 * notice carrying something that must never sit in a group chat's permanent
 * history.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CATEGORIES, CATEGORY_KEYS, getCategory, isKnownCategory, resolveDestination,
} = require('../lib/notifications/categories');
const {
  composeNotice, sanitise, clip, noticeKeyFor, MAX_BODY,
} = require('../lib/notifications/compose');

// ── the catalogue ────────────────────────────────────────────────────────────

test('every category is described well enough to decide where to send it', () => {
  for (const c of CATEGORIES) {
    assert.match(c.key, /^[a-z][a-z0-9_]*$/, `${c.key} is a stable key`);
    assert.ok(c.label && !c.label.includes('_'), `${c.key} reads as English`);
    assert.ok(c.what && c.what.length > 25, `${c.key} says what lands in this chat`);
    assert.ok(['info', 'warning', 'serious'].includes(c.severity), `${c.key} has a severity`);
    assert.equal(typeof c.humanActionUsually, 'boolean',
      `${c.key} must answer "will I have to do something about these?"`);
  }
});

test('keys are unique — two categories sharing one would silently merge traffic', () => {
  assert.equal(new Set(CATEGORY_KEYS).size, CATEGORY_KEYS.length);
});

test('an unknown category is null rather than a guess', () => {
  assert.equal(getCategory('nope'), null);
  assert.equal(isKnownCategory('nope'), false);
  assert.equal(isKnownCategory('fuel'), true);
});

// ── routing ──────────────────────────────────────────────────────────────────

test('a category with no override goes to the default group', () => {
  const r = resolveDestination('fuel', { defaultChatId: '-100111' });
  assert.deepEqual(r, { chatId: '-100111', via: 'default' });
});

test('an override wins over the default', () => {
  const r = resolveDestination('fuel', {
    defaultChatId: '-100111', overrides: { fuel: '-100222' },
  });
  assert.deepEqual(r, { chatId: '-100222', via: 'override' });
});

test('an override for ANOTHER category does not capture this one', () => {
  const r = resolveDestination('fuel', {
    defaultChatId: '-100111', overrides: { retention: '-100222' },
  });
  assert.equal(r.chatId, '-100111');
});

test('a CLEARED override means "use the default", not "send nowhere"', () => {
  // The admin form writes an empty string when a field is emptied. Treating
  // that as a destination is how a feature goes quiet without anyone noticing.
  for (const blank of ['', '   ', null, undefined]) {
    const r = resolveDestination('fuel', { defaultChatId: '-100111', overrides: { fuel: blank } });
    assert.equal(r.chatId, '-100111', `${JSON.stringify(blank)} must fall through`);
    assert.equal(r.via, 'default');
  }
});

test('no default and no override is reported as "none", never as a silent drop', () => {
  const r = resolveDestination('fuel', { defaultChatId: '  ' });
  assert.deepEqual(r, { chatId: null, via: 'none' });
});

test('a new category added in code is delivered immediately, not after configuration', () => {
  // Every catalogued category resolves somewhere as soon as a default exists.
  for (const key of CATEGORY_KEYS) {
    assert.equal(resolveDestination(key, { defaultChatId: '-100111' }).chatId, '-100111');
  }
});

// ── what a notice may say ────────────────────────────────────────────────────

test('a notice is a heading, the facts, and at most one thing to do', () => {
  const body = composeNotice({
    icon: '⛽', title: 'Unit 310 may not reach its fuel stop',
    lines: ['Assigned: Pilot #442, 180 mi ahead', 'Range now: about 120 mi'],
    action: 'Reassign or call the driver',
  });
  assert.match(body, /^⛽ <b>Unit 310 may not reach its fuel stop<\/b>/);
  assert.match(body, /→ Reassign or call the driver$/);
});

test('a model explanation is clipped hard — the audit keeps the long version', () => {
  const body = composeNotice({
    title: 'x', reason: 'because '.repeat(200),
  });
  assert.ok(body.length < 400, `a paragraph reached the chat: ${body.length} chars`);
  assert.match(body, /…<\/i>$/);
});

test('a whole notice can never exceed the body cap', () => {
  const body = composeNotice({
    title: 'y'.repeat(500),
    lines: Array.from({ length: 80 }, (_, i) => `line ${i} ${'z'.repeat(200)}`),
  });
  assert.ok(body.length <= MAX_BODY, `${body.length} > ${MAX_BODY}`);
});

test('HTML in a driver name or an error cannot break the message', () => {
  const body = composeNotice({ title: 'Driver <b>X</b> & co', lines: ['<script>alert(1)</script>'] });
  assert.equal(body.includes('<script>'), false);
  assert.match(body, /&lt;script&gt;/);
  assert.match(body, /&amp; co/);
});

// ── what a notice may NEVER say ──────────────────────────────────────────────

test('a signed media URL never reaches a chat that keeps history forever', () => {
  const out = sanitise('video: https://media.samsara.com/a/b.mp4?sig=abcdef123456&expires=999');
  assert.equal(out.includes('sig='), false);
  assert.match(out, /\[link removed\]/);
});

test('an echoed authorization header is redacted', () => {
  for (const shape of [
    'Authorization: Bearer wenze-live-key',
    'api_key=wenze-live-key',
    'API-KEY: wenze-live-key',
  ]) {
    assert.equal(sanitise(shape).includes('wenze-live-key'), false, shape);
  }
});

test('a bare long token is redacted even with no label around it', () => {
  const token = 'A'.repeat(40);
  assert.equal(sanitise(`failed with ${token}`).includes(token), false);
});

test('sanitising runs on every part of the notice, not only the reason', () => {
  const token = 'B'.repeat(40);
  const body = composeNotice({
    title: `t ${token}`, lines: [`l ${token}`], reason: `r ${token}`, action: `a ${token}`,
  });
  assert.equal(body.includes(token), false, 'a token survived somewhere in the body');
});

test('an ordinary unit number or chat id is NOT mistaken for a secret', () => {
  const body = composeNotice({ title: 'Unit 310', lines: ['Group -1001234567890', '4 days at home'] });
  assert.match(body, /Unit 310/);
  assert.match(body, /-1001234567890/);
  assert.match(body, /4 days at home/);
});

// ── saying a thing once ──────────────────────────────────────────────────────

test('the same event produces the same key, so a repeat check cannot resend', () => {
  const a = noticeKeyFor('fuel', 'group', 7, 'stop-442');
  const b = noticeKeyFor('fuel', 'group', 7, 'stop-442');
  assert.equal(a, b);
});

test('a different event on the same subject is a different key', () => {
  assert.notEqual(
    noticeKeyFor('fuel', 'group', 7, 'stop-442'),
    noticeKeyFor('fuel', 'group', 7, 'stop-901')
  );
  assert.notEqual(
    noticeKeyFor('fuel', 'group', 7),
    noticeKeyFor('retention', 'group', 7)
  );
});

test('clip leaves short text exactly alone', () => {
  assert.equal(clip('already short', 100), 'already short');
});

// ── truncation must never break the markup ───────────────────────────────────

test('a body of ampersands is cut on the TEXT, never through an entity', () => {
  // Escaping turns one `&` into five characters, so a notice whose plain text
  // fits can arrive at several times the limit — and slicing the escaped form
  // leaves a dangling `&amp` that Telegram rejects as malformed HTML on every
  // retry until the notice is abandoned.
  const amp = 'a & b & c '.repeat(40);
  const body = composeNotice({ title: 't', lines: Array(8).fill(amp), action: 'call the driver' });

  assert.ok(body.length <= MAX_BODY, `${body.length} > ${MAX_BODY} — the ESCAPED body is what Telegram gets`);
  assert.equal(/&[a-z]*$|&#?[0-9a-z]*$/i.test(body), false, 'a half-written entity reached the message');
  assert.equal(/<[^>]*$/.test(body), false, 'a half-written tag reached the message');
});

test('the tags always balance, whatever was dropped', () => {
  const body = composeNotice({
    title: 'x'.repeat(300), lines: Array(20).fill('y'.repeat(200)),
    reason: 'z'.repeat(400), action: 'do it',
  });
  assert.equal((body.match(/<b>/g) || []).length, (body.match(/<\/b>/g) || []).length);
  assert.equal((body.match(/<i>/g) || []).length, (body.match(/<\/i>/g) || []).length);
});

test('the heading and the thing to do survive; the middle is what goes', () => {
  const body = composeNotice({
    title: 'Unit 310 may not reach its fuel stop',
    lines: Array(30).fill('a supporting detail '.repeat(8)),
    action: 'Reassign or call the driver',
  });
  assert.match(body, /Unit 310 may not reach its fuel stop/, 'a reader needs to know what happened');
  assert.match(body, /Reassign or call the driver/, 'and what to do');
});

test('one enormous title alone is still a valid message', () => {
  const body = composeNotice({ title: '&'.repeat(3000) });
  assert.ok(body.length <= MAX_BODY);
  assert.equal(/&[a-z]*$/i.test(body), false);
  assert.match(body, /<\/b>$/, 'the closing tag is added after the cut, so it cannot be cut');
});
