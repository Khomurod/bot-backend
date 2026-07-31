/**
 * QBQ presentation editing — the two pure guards that stand between a
 * contenteditable in a browser and a row in PostgreSQL.
 *
 * sanitizeEditableText is the reason stored presentation content cannot carry
 * script: it does not allow-list tags, it removes them. elementPath is the
 * reason a save lands on the element it came from and cannot address anything
 * else. Both are pure, so this suite needs no server and no database.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sanitizeEditableText,
  InvalidEditableTextError,
  MAX_LENGTH,
} = require('../services/qbq/sanitizeEditableText');
const {
  parseElementPath,
  isValidElementPath,
  InvalidElementPathError,
  MAX_SLIDE_INDEX,
} = require('../services/qbq/elementPath');

// ─── sanitizeEditableText ───────────────────────────────────────────────────

test('plain Uzbek text survives untouched', () => {
  const text = 'Ikki oy o‘tib, Jeykob lavozimga ko‘tarildi.';
  assert.equal(sanitizeEditableText(text), text);
});

test('markup is stripped, never stored and never executed', () => {
  const cases = [
    ['<script>alert(1)</script>Salom', 'alert(1)Salom'],
    ['<img src=x onerror=alert(1)>Matn', 'Matn'],
    ['<b>Qalin</b> matn', 'Qalin matn'],
    ['<div onclick="steal()">Bosing</div>', 'Bosing'],
    ['<a href="javascript:alert(1)">link</a>', 'link'],
    // An unterminated tag must not leave a live "<" behind either.
    ['Matn <script', 'Matn'],
  ];
  for (const [input, expected] of cases) {
    const out = sanitizeEditableText(input);
    assert.equal(out, expected, `input: ${input}`);
    assert.ok(!out.includes('<'), `sanitized output still contains "<": ${out}`);
    assert.ok(!out.includes('>'), `sanitized output still contains ">": ${out}`);
  }
});

test('<br> in any spelling becomes a newline before tags are removed', () => {
  assert.equal(sanitizeEditableText('Bir<br>Ikki'), 'Bir\nIkki');
  assert.equal(sanitizeEditableText('Bir<BR/>Ikki'), 'Bir\nIkki');
  assert.equal(sanitizeEditableText('Bir<br />Ikki'), 'Bir\nIkki');
  // Line breaks must not be silently lost — they carry slide layout meaning.
  assert.equal(sanitizeEditableText('Bir<br><br>Ikki'), 'Bir\n\nIkki');
});

test('CRLF is normalized and runaway blank lines collapse', () => {
  assert.equal(sanitizeEditableText('Bir\r\nIkki'), 'Bir\nIkki');
  assert.equal(sanitizeEditableText('Bir\n\n\n\n\nIkki'), 'Bir\n\nIkki');
  assert.equal(sanitizeEditableText('Bir   \nIkki'), 'Bir\nIkki');
});

test('control characters and zero-width paste residue are removed', () => {
  assert.equal(sanitizeEditableText('A\u0000B'), 'AB');
  assert.equal(sanitizeEditableText('A\u0085B'), 'AB');
  assert.equal(sanitizeEditableText('A\u200BB\uFEFFC'), 'ABC');
  // Tab is legitimate content and must survive.
  assert.equal(sanitizeEditableText('A\tB'), 'A\tB');
});

test('empty or whitespace-only content is refused, so a slide cannot be blanked', () => {
  for (const input of ['', '   ', '\n\n', '<br>', '<span></span>']) {
    assert.throws(
      () => sanitizeEditableText(input),
      (err) => err instanceof InvalidEditableTextError && err.code === 'CONTENT_EMPTY',
      `expected ${JSON.stringify(input)} to be refused`,
    );
  }
});

test('over-long and non-string content is refused', () => {
  assert.equal(sanitizeEditableText('x'.repeat(MAX_LENGTH)).length, MAX_LENGTH);
  assert.throws(
    () => sanitizeEditableText('x'.repeat(MAX_LENGTH + 1)),
    (err) => err.code === 'CONTENT_TOO_LONG',
  );
  for (const bad of [null, undefined, 42, {}, ['a'], true]) {
    assert.throws(
      () => sanitizeEditableText(bad),
      (err) => err.code === 'CONTENT_NOT_STRING',
      `expected ${JSON.stringify(bad)} to be refused`,
    );
  }
});

// ─── elementPath ────────────────────────────────────────────────────────────

test('a valid path parses and derives its own slide index', () => {
  assert.deepEqual(parseElementPath('s11.0.2'), { elementPath: 's11.0.2', slideIndex: 11 });
  assert.deepEqual(parseElementPath('s0.0'), { elementPath: 's0.0', slideIndex: 0 });
  assert.deepEqual(parseElementPath('  s3.1.4.1  '), { elementPath: 's3.1.4.1', slideIndex: 3 });
  assert.equal(parseElementPath(`s${MAX_SLIDE_INDEX}.0`).slideIndex, MAX_SLIDE_INDEX);
});

test('the slide index comes from the path, so it cannot disagree with it', () => {
  // A caller cannot smuggle a different slide number alongside the path —
  // there is only one source for it.
  assert.equal(parseElementPath('s27.3').slideIndex, 27);
});

test('malformed, non-canonical and out-of-range paths are rejected', () => {
  const bad = [
    'p11.0.2',            // wrong prefix
    's11',                // no child chain
    's11.',               // trailing dot
    's11..0',             // empty segment
    's01.0',              // leading zero is not canonical
    's11.00',             // leading zero in a child segment
    's11.0.2; DROP TABLE qbq_presentation_edits',
    "s11.0' OR '1'='1",
    's11.0/../../etc/passwd',
    `s${MAX_SLIDE_INDEX + 1}.0`,
    's1' + '.0'.repeat(17), // deeper than MAX_DEPTH
    's-1.0',
    '',
    'S11.0',              // case matters; keep one canonical spelling
  ];
  for (const value of bad) {
    assert.equal(isValidElementPath(value), false, `expected ${JSON.stringify(value)} invalid`);
    assert.throws(
      () => parseElementPath(value),
      (err) => err instanceof InvalidElementPathError && err.code === 'INVALID_ELEMENT_PATH',
    );
  }
});

test('non-string paths are rejected without throwing a TypeError', () => {
  for (const bad of [null, undefined, 7, {}, ['s1.0']]) {
    assert.equal(isValidElementPath(bad), false);
    assert.throws(() => parseElementPath(bad), InvalidElementPathError);
  }
});
