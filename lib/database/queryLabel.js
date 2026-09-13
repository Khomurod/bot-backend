'use strict';

/**
 * Which table a query read, derived from the SQL itself.
 *
 * WHY IT EXISTS. `database/transferMeter.js` has answered "how much of the
 * monthly transfer allowance has been used" since the deployment reached
 * 4.222 GB of 5 GB with nothing watching. That is the right alarm and the
 * wrong amount of information: a number going up tells an operator to worry
 * and not what to do about it. "78% used" and "78% used, 61% of it reading
 * `group_messages`" are the same alarm and different mornings.
 *
 * THREE RULES, AND EACH IS A WAY THIS COULD HAVE GONE WRONG.
 *
 * 1. IT IS PURE, AND IT RUNS ON EVERY QUERY. A parser here is a tax on every
 *    read in the application, so this is one regular expression against the
 *    front of the statement and nothing else. It does not understand SQL, it
 *    does not need to, and a statement it cannot read costs one failed match.
 *
 * 2. IT RETURNS AN IDENTIFIER OR NOTHING — NEVER A FRAGMENT OF THE QUERY.
 *    SQL text carries literals, and literals carry driver names, phone numbers
 *    and money codes. The capture is `[A-Za-z_][A-Za-z0-9_$]*`, so what comes
 *    back is a table name or `null`. A label that echoed part of a WHERE clause
 *    would put payment data in a diagnostics endpoint, which is the opposite of
 *    what this application spent a whole phase making impossible.
 *
 * 3. CARDINALITY IS THE CALLER'S PROBLEM AND IT IS BOUNDED. This module can
 *    only ever return a name that appears in this repository's own SQL, so the
 *    set is finite; the meter still caps it, because a diagnostic that grows
 *    without limit is a memory leak wearing a chart.
 */

/**
 * The first table named by a statement.
 *
 * `FROM` and `JOIN` cover reads, which are what a transfer allowance is spent
 * on; `INTO` and `UPDATE` are here so a write-heavy table is not invisible.
 * The schema qualifier is dropped — `public.groups` and `groups` are one table
 * and splitting them would only split the answer.
 */
const TABLE_RE = /\b(?:from|join|into|update)\s+(?:only\s+)?"?([A-Za-z_][A-Za-z0-9_$]*)"?(?:\s*\.\s*"?([A-Za-z_][A-Za-z0-9_$]*)"?)?/i;

/** Statements that name no table, or name one this cannot read. */
const UNKNOWN = 'other';

/**
 * @param {string} text  the SQL as it was sent
 * @returns {string} a table name, or `other`. Never a fragment of the query.
 */
function labelForQuery(text) {
  if (typeof text !== 'string' || !text) return UNKNOWN;
  const m = TABLE_RE.exec(text);
  if (!m) return UNKNOWN;
  // With a schema qualifier the SECOND capture is the table; without one the
  // first is. `public.groups` and `groups` must not become two answers.
  const name = (m[2] || m[1] || '').toLowerCase();
  return name || UNKNOWN;
}

module.exports = { labelForQuery, UNKNOWN, TABLE_RE };
