'use strict';

/**
 * The one place that decides what may be stored as presentation text.
 *
 * The rule is deliberately absolute: **stored content is PLAIN TEXT**. Not
 * "HTML with a tag allow-list" — plain text. The browser sends `innerText`,
 * this strips anything that looks like markup, and the page re-applies the
 * result with `textContent` plus real <br> nodes rather than `innerHTML`.
 *
 * That closes the XSS question by construction instead of by vigilance: there
 * is no parser to outsmart, no attribute to overlook, and no way for a stored
 * value to become executable if some future caller renders it carelessly.
 *
 * Pure module: no I/O, no database, no Express.
 */

/** Generous for a slide, small enough that a runaway paste is caught. */
const MAX_LENGTH = 4000;

class InvalidEditableTextError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'InvalidEditableTextError';
    this.code = code;
  }
}

/** <br> in any spelling becomes a newline before tags are stripped. */
const BR_RE = /<\s*br\s*\/?\s*>/gi;

/** Anything else that opens a tag, including an unclosed trailing "<script". */
const TAG_RE = /<[^>]*>?/g;

/**
 * C0 controls except tab (\x09) and newline (\x0A), DEL, the C1 block, plus the
 * zero-width characters and BOM that a paste from a word processor drags along.
 * Written with escapes only: literal control bytes in a source file are
 * invisible in review and do not survive a careless editor.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x08\x0B-\x1F\x7F-\x9F\u200B-\u200D\uFEFF]/g;

/**
 * Normalize and strip one edited element's text.
 *
 * @param {unknown} raw text as typed by the presenter
 * @returns {string} plain text, newlines preserved, never empty
 * @throws {InvalidEditableTextError} on a non-string, an over-long value, or a
 *   value that is empty once stripped
 */
function sanitizeEditableText(raw) {
  if (typeof raw !== 'string') {
    throw new InvalidEditableTextError('content must be a string', 'CONTENT_NOT_STRING');
  }
  // Bound BEFORE the regex work so a multi-megabyte body cannot make the
  // server do all the scanning first and reject afterwards.
  if (raw.length > MAX_LENGTH) {
    throw new InvalidEditableTextError(
      `content must be at most ${MAX_LENGTH} characters`,
      'CONTENT_TOO_LONG',
    );
  }

  const text = raw
    .replace(/\r\n?/g, '\n')
    .replace(BR_RE, '\n')
    .replace(TAG_RE, '')
    .replace(CONTROL_RE, '')
    // Collapse the runs of blank lines a contenteditable tends to leave behind.
    .replace(/\n{3,}/g, '\n\n')
    // Trailing spaces before a newline are invisible noise in a diff.
    .replace(/[ \t]+\n/g, '\n')
    .trim();

  // Blanking an element is refused rather than saved. In a deck with a fixed
  // design an empty save is far more likely to be a stray keystroke inside a
  // contenteditable than an intention, and refusing it leaves the previously
  // saved text in place instead of quietly erasing a slide.
  if (!text) {
    throw new InvalidEditableTextError('content must not be empty', 'CONTENT_EMPTY');
  }
  return text;
}

module.exports = {
  MAX_LENGTH,
  InvalidEditableTextError,
  sanitizeEditableText,
};
