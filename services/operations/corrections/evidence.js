/**
 * "Is the evidence still what we thought it was?" — pure, no I/O.
 *
 * A finding is a photograph of a moment. By the time a correction runs, minutes
 * or hours later, a person may have edited the very rows the proposal was built
 * from — not the target column (that case is easy to spot), but the EVIDENCE
 * behind it: the home arrival the duration was measured from, the observed
 * transition the return timestamp was copied out of.
 *
 * So an action never trusts its payload. It re-reads the evidence inside its own
 * transaction, re-derives the answer, and applies only when the two agree. When
 * they do not, the correct outcome is to do NOTHING and let a human look — which
 * is what StaleCorrectionError means everywhere in this directory: not a failure,
 * a deliberate stand-down.
 *
 * The same rule runs backwards. A revert re-applies a before-image, and doing
 * that blindly would destroy an edit somebody made after the correction landed.
 * `assertUnchangedSince` is what makes a revert an undo rather than an overwrite.
 */

class StaleCorrectionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StaleCorrectionError';
    this.stale = true;
  }
}

/** Two timestamps describing the same instant, whatever shape they arrive in. */
function sameInstant(a, b) {
  if (a == null || b == null) return a == null && b == null;
  const da = a instanceof Date ? a : new Date(a);
  const db = b instanceof Date ? b : new Date(b);
  if (Number.isNaN(da.getTime()) || Number.isNaN(db.getTime())) return false;
  return da.getTime() === db.getTime();
}

/**
 * Does a value read back from a live row still match the one recorded in JSONB?
 *
 * The two sides genuinely differ in shape: `pg` hands back a Date for a
 * timestamp and a number for an integer, while `old_values`/`new_values` come
 * out of JSONB as ISO strings and numbers. Comparing them with `===` would call
 * every unchanged row changed, so normalise first and compare deliberately.
 */
function valuesMatch(recorded, current) {
  if (recorded == null || current == null) return recorded == null && current == null;
  if (recorded instanceof Date || current instanceof Date) return sameInstant(recorded, current);
  // An ISO-looking string on one side and a Date on the other is the common case
  // above; anything else compares as text, which is right for ids and statuses.
  return String(recorded) === String(current);
}

/**
 * Refuse to write unless every field this correction changed is still as it left
 * them.
 *
 * @param {object} expected  the recorded image (usually `correction.new_values`)
 * @param {object} current   the row as it is right now
 * @param {string} what      how to name the target in the error
 */
function assertUnchangedSince(expected, current, what) {
  for (const [field, recorded] of Object.entries(expected || {})) {
    if (!valuesMatch(recorded, current?.[field])) {
      throw new StaleCorrectionError(
        `${what} has changed since this correction was applied `
        + `(${field} is no longer what it was set to) — refusing to overwrite the newer edit.`
      );
    }
  }
}

module.exports = { StaleCorrectionError, sameInstant, valuesMatch, assertUnchangedSince };
