'use strict';

/**
 * Split a SQL script into individual top-level statements on semicolons,
 * correctly ignoring semicolons that live inside:
 *   - single-quoted string literals ('...', with '' escape)
 *   - dollar-quoted strings ($tag$ ... $tag$, including $$ ... $$)
 *   - line comments (-- to end of line)
 *   - block comments (/* ... *\/, non-nested as per standard SQL)
 *
 * Needed only for `-- migrate:no-transaction` migrations: those cannot be sent
 * as one multi-statement query (that forms an implicit transaction block, which
 * CREATE INDEX CONCURRENTLY and friends forbid), so each statement is executed
 * on its own. Transactional migrations are sent whole and do not use this.
 *
 * Returns statements with surrounding whitespace trimmed and empties dropped;
 * the trailing separator is not included.
 */
function splitStatements(sql) {
  const statements = [];
  let current = '';
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];

    // line comment
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }

    // block comment
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }

    // single-quoted string
    if (ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
        if (sql[j] === "'") { j += 1; break; }
        j += 1;
      }
      current += sql.slice(i, j);
      i = j;
      continue;
    }

    // dollar-quoted string: $tag$ ... $tag$
    if (ch === '$') {
      const tagMatch = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? n : end + tag.length;
        current += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }

    if (ch === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  if (current.trim()) statements.push(current.trim());
  return statements;
}

module.exports = { splitStatements };
