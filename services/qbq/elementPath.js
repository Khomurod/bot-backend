'use strict';

/**
 * Stable addressing for editable elements in the hosted /qbq presentation.
 *
 * The deck is a generated file with no ids on its text nodes, and adding a few
 * hundred of them would bloat the template for no gain. Instead an element is
 * addressed by where it SITS:
 *
 *   s<slideIndex>.<childIndex>[.<childIndex>…]      e.g.  s11.0.2
 *
 * `slideIndex` is the slide's position among the deck's <section> children;
 * each `childIndex` is an element-child position walking down to the target.
 * The browser computes the path when saving and resolves it when loading; this
 * module is the single authority on what a legal path looks like, so a
 * malformed or hostile value never reaches SQL.
 *
 * The form is CANONICAL — no leading zeros — so the same element can only ever
 * produce one string. Without that, "s01.0" and "s1.0" would become two rows
 * for one element and the later save would appear to vanish.
 *
 * Pure module: no I/O, no database, no Express.
 */

/** Deck slide ceiling. The SOS deck has 28; the bound is just a sanity guard. */
const MAX_SLIDE_INDEX = 199;

/** Deepest child chain accepted. The deck's real maximum nesting is ~6. */
const MAX_DEPTH = 16;

const SEGMENT = '(?:0|[1-9]\\d{0,2})';
const ELEMENT_PATH_RE = new RegExp(`^s(${SEGMENT})((?:\\.${SEGMENT}){1,${MAX_DEPTH}})$`);

class InvalidElementPathError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidElementPathError';
    this.code = 'INVALID_ELEMENT_PATH';
  }
}

/**
 * Validate a path and pull the slide index out of it.
 *
 * The slide index is derived from the path rather than trusted from the request
 * body, so the two can never disagree in the database.
 *
 * @param {unknown} raw
 * @returns {{elementPath: string, slideIndex: number}}
 * @throws {InvalidElementPathError}
 */
function parseElementPath(raw) {
  if (typeof raw !== 'string') {
    throw new InvalidElementPathError('element path must be a string');
  }
  const value = raw.trim();
  const match = ELEMENT_PATH_RE.exec(value);
  if (!match) {
    throw new InvalidElementPathError(
      'element path must look like s<slide>.<child>[.<child>…] with no leading zeros',
    );
  }
  const slideIndex = Number(match[1]);
  if (slideIndex > MAX_SLIDE_INDEX) {
    throw new InvalidElementPathError(`slide index must be <= ${MAX_SLIDE_INDEX}`);
  }
  return { elementPath: value, slideIndex };
}

/** Non-throwing form, for callers that only need a yes/no. */
function isValidElementPath(raw) {
  try {
    parseElementPath(raw);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  MAX_SLIDE_INDEX,
  MAX_DEPTH,
  InvalidElementPathError,
  parseElementPath,
  isValidElementPath,
};
