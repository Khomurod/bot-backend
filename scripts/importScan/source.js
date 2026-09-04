'use strict';

/**
 * Reading JavaScript with regular expressions, safely enough.
 *
 * Everything here exists to answer two questions about a file — what does it
 * import, what does it export — WITHOUT a parser dependency, matching the rest
 * of scripts/ (dependency-free, runs before `npm install` finishes).
 *
 * `scrubNonCode` is the part that makes that honest. The first version of this
 * scan matched imports and export keys against the raw text, and every one of
 * its findings was a false positive: an `import { x } from './x'` inside a
 * DOC COMMENT, a fixture module written as a STRING in a test, and — the one
 * that mattered — an export list whose real key was hidden because a comma
 * inside a `// comment` split the object entry in half. A gate that cries wolf
 * is worse than no gate, so comments, string and template bodies, and regex
 * literals are blanked out (newlines preserved, so reported line numbers stay
 * correct) before anything is matched.
 */

/** Characters after which a `/` begins a regex literal rather than division. */
const REGEX_ALLOWED_BEFORE = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%',
  '<', '>', '~', '^', '\n', undefined,
]);

/**
 * Keywords after which a `/` also begins a regex literal.
 *
 * Character-only lookback is not enough: `return /["\n]/.test(s)` ends in `n`,
 * so the slash read as division, the `"` inside the character class opened a
 * string, and the scrubber blanked the rest of the file — including the
 * `module.exports` block, which then looked like a module exporting nothing.
 */
const REGEX_ALLOWED_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await',
]);

/**
 * Replace comments, string/template bodies and regex literals with spaces,
 * keeping every newline (and every offset) so line numbers and slice positions
 * stay valid.
 *
 * Template literals are tracked with a STACK rather than "blank until the next
 * backtick". A nested template inside an interpolation —
 * `${rows.length ? `<div>…</div>` : ''}`, which the Facebook connect pages use
 * throughout — made the flat version treat the inner opening backtick as the
 * outer closing one. Parity flipped, real code was blanked as if it were
 * string content, and the module's whole `module.exports` block disappeared.
 */
function scrubNonCode(text) {
  const out = [];
  let lastSignificant;
  let lastWord = '';
  let i = 0;

  const keep = (ch) => {
    out.push(ch);
    if (!/\s/.test(ch)) lastSignificant = ch;
    if (/[A-Za-z_$0-9]/.test(ch)) lastWord += ch;
    else if (!/\s/.test(ch)) lastWord = '';
  };
  const blank = (ch) => out.push(ch === '\n' ? '\n' : ' ');

  /** Would a `/` here open a regex literal, rather than divide? */
  const regexAhead = () => REGEX_ALLOWED_BEFORE.has(lastSignificant)
    || REGEX_ALLOWED_KEYWORDS.has(lastWord);

  // `code` frames count braces so an interpolation knows its own closing `}`.
  const stack = [{ type: 'code', braceDepth: 0, interpolation: false }];

  while (i < text.length) {
    const frame = stack[stack.length - 1];
    const ch = text[i];
    const next = text[i + 1];

    if (frame.type === 'template') {
      if (ch === '\\') { blank(text[i]); i += 1; if (i < text.length) { blank(text[i]); i += 1; } continue; }
      if (ch === '`') { keep(ch); i += 1; stack.pop(); continue; }
      if (ch === '$' && next === '{') {
        keep(ch); keep(next); i += 2;
        stack.push({ type: 'code', braceDepth: 0, interpolation: true });
        continue;
      }
      blank(ch); i += 1;
      continue;
    }

    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') { blank(text[i]); i += 1; }
      continue;
    }
    if (ch === '/' && next === '*') {
      blank(text[i]); i += 1; blank(text[i]); i += 1;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) { blank(text[i]); i += 1; }
      if (i < text.length) { blank(text[i]); i += 1; blank(text[i]); i += 1; }
      continue;
    }
    if (ch === '"' || ch === "'") {
      keep(ch); i += 1;
      while (i < text.length) {
        if (text[i] === '\\') { blank(text[i]); i += 1; if (i < text.length) { blank(text[i]); i += 1; } continue; }
        if (text[i] === ch || text[i] === '\n') break;
        blank(text[i]); i += 1;
      }
      if (i < text.length && text[i] === ch) { keep(text[i]); i += 1; }
      continue;
    }
    if (ch === '`') {
      keep(ch); i += 1;
      stack.push({ type: 'template' });
      continue;
    }
    if (ch === '/' && regexAhead()) {
      keep(ch); i += 1;
      let inClass = false;
      while (i < text.length) {
        if (text[i] === '\\') { blank(text[i]); i += 1; if (i < text.length) { blank(text[i]); i += 1; } continue; }
        if (text[i] === '[') inClass = true;
        else if (text[i] === ']') inClass = false;
        else if (text[i] === '/' && !inClass) break;
        else if (text[i] === '\n') break;
        blank(text[i]); i += 1;
      }
      if (i < text.length && text[i] === '/') { keep(text[i]); i += 1; }
      continue;
    }
    if (ch === '{') { frame.braceDepth += 1; keep(ch); i += 1; continue; }
    if (ch === '}') {
      if (frame.interpolation && frame.braceDepth === 0) {
        keep(ch); i += 1; stack.pop();
        continue;
      }
      frame.braceDepth = Math.max(0, frame.braceDepth - 1);
      keep(ch); i += 1;
      continue;
    }
    keep(ch);
    i += 1;
  }
  return out.join('');
}

/** Balanced-brace body starting at the `{` at or after `from`. */
function braceBlock(text, from) {
  const start = text.indexOf('{', from);
  if (start < 0) return '';
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start + 1, i);
    }
  }
  return '';
}

/**
 * Top-level keys of an object-literal body.
 *
 * `complete: false` means the surface is not fully knowable — a spread or a
 * computed key could supply any name — and callers must then report nothing
 * against it.
 */
function objectKeys(body) {
  const names = new Set();
  let complete = true;
  let depth = 0;
  let buf = '';

  const flush = () => {
    const piece = buf.trim();
    buf = '';
    if (!piece) return;
    if (piece.startsWith('...')) { complete = false; return; }
    if (piece.startsWith('[')) { complete = false; return; }
    const name = piece.split(/[:(]/)[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
  };

  for (const ch of body) {
    if ('{[('.includes(ch)) depth += 1;
    else if ('}])'.includes(ch)) depth -= 1;
    if (ch === ',' && depth === 0) flush();
    else buf += ch;
  }
  flush();
  return { names, complete };
}

/**
 * The names REQUESTED from a module by an `{ a, b as c }` clause — `a` and `b`,
 * not the local aliases.
 */
function requestedNames(clause) {
  return clause
    .split(',')
    .map((piece) => piece.split(/\s+as\s+/)[0].trim())
    .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
}

module.exports = { scrubNonCode, braceBlock, objectKeys, requestedNames };
