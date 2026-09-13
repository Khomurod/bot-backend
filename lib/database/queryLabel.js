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
 *    back is a table name or `other`. A label that echoed part of a WHERE
 *    clause would put payment data in a diagnostics endpoint, which is the
 *    opposite of what this application spent a whole phase making impossible.
 *
 *    THE CAPTURE SHAPE IS NOT ENOUGH ON ITS OWN, and the first version of this
 *    module proved it. A pattern is only SQL structure where SQL structure is
 *    allowed, and `from` inside a comment or a string is neither:
 *
 *        /* report from Alice_Smith *\/ SELECT * FROM groups   ->  alice_smith
 *        SELECT 'sent from John_Doe'                            ->  john_doe
 *
 *    Both are well-formed identifiers by the capture's rules and both are a
 *    person's name on a diagnostics endpoint. `stripNoise` removes comments and
 *    quoted literals BEFORE the match, so the pattern only ever sees places a
 *    table name can legally appear.
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

/** Is there anything in here that could hide a keyword? One cheap test. */
const HAS_NOISE = /'|--|\/\*|\$\$/;

/**
 * Blank out everything that is text rather than structure.
 *
 * Comments and quoted literals become a single space, so a keyword inside one
 * cannot be read as the statement's own. DOUBLE quotes are deliberately left
 * alone: in PostgreSQL those delimit an IDENTIFIER, which is exactly what this
 * is looking for — `"Groups"` is a table and `'Groups'` is a value.
 *
 * A single left-to-right pass, because the alternative — stripping comments and
 * then literals — mangles a literal containing `--`. Unterminated anything runs
 * to the end of the statement, which is the safe direction: it costs a label
 * and cannot leak one.
 */
function stripNoise(sql) {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];

    if (c === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i += 1;
      out += ' ';
      continue;
    }

    // Block comments NEST in PostgreSQL, so this counts depth rather than
    // stopping at the first close.
    if (c === '/' && sql[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth += 1; i += 2; continue; }
        if (sql[i] === '*' && sql[i + 1] === '/') { depth -= 1; i += 2; continue; }
        i += 1;
      }
      out += ' ';
      continue;
    }

    if (c === "'") {
      i += 1;
      while (i < n) {
        // `''` is an escaped quote inside the literal, not the end of it.
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; }
          i += 1;
          break;
        }
        i += 1;
      }
      out += ' ';
      continue;
    }

    // Dollar quoting: `$$ … $$` or `$tag$ … $tag$`, which migrations use for DO
    // blocks whose bodies are full of FROM. A `$1` placeholder is not one of
    // these — it needs a closing `$` to match — so parameters pass through.
    if (c === '$') {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        i = end === -1 ? n : end + tag[0].length;
        out += ' ';
        continue;
      }
    }

    out += c;
    i += 1;
  }
  return out;
}

/**
 * @param {string} text  the SQL as it was sent
 * @returns {string} a table name, or `other`. Never a fragment of the query.
 */
function labelForQuery(text) {
  if (typeof text !== 'string' || !text) return UNKNOWN;
  const sql = HAS_NOISE.test(text) ? stripNoise(text) : text;
  const m = TABLE_RE.exec(sql);
  if (!m) return UNKNOWN;
  // With a schema qualifier the SECOND capture is the table; without one the
  // first is. `public.groups` and `groups` must not become two answers.
  const name = (m[2] || m[1] || '').toLowerCase();
  return name || UNKNOWN;
}

module.exports = { labelForQuery, stripNoise, UNKNOWN, TABLE_RE };
