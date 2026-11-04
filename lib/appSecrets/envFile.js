'use strict';

/**
 * Read the text of a .env file into names and values — pure, no I/O.
 *
 * Settings → Secrets takes the deployment's environment as one pasted or
 * uploaded .env file (docs/architecture/app-secrets.md). This is the reader.
 * It understands what Coolify's and Render's "copy as .env" produce and what a
 * person types by hand:
 *
 *   NAME=value            NAME="value with spaces"    NAME='single quoted'
 *   export NAME=value     # a comment                 NAME=value # a comment
 *
 * Double-quoted values honour \n, \" and \\; nothing else is interpreted (no
 * ${VAR} expansion — a value is stored exactly as written). A name must be
 * UPPER_SNAKE_CASE, the only shape the database accepts. A name given twice
 * keeps its LAST value, as dotenv and Docker do, and is reported.
 *
 * NEVER puts a value into an error or a warning: problems carry the line
 * number and the name only.
 */

const NAME = /^[A-Z_][A-Z0-9_]*$/;

function unquoteDouble(body) {
  return body.replace(/\\(.)/g, (_, ch) => {
    if (ch === 'n') return '\n';
    if (ch === 'r') return '\r';
    if (ch === 't') return '\t';
    return ch;
  });
}

/**
 * @param {string} text
 * @returns {{
 *   entries: {name: string, value: string, line: number}[],
 *   problems: {line: number, name?: string, reason: string}[],
 *   duplicates: string[],
 * }}
 */
function parseEnvText(text) {
  const entries = new Map();
  const problems = [];
  const duplicates = new Set();
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const lineNo = index + 1;
    let line = lines[index].trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();

    const eq = line.indexOf('=');
    if (eq <= 0) {
      problems.push({ line: lineNo, reason: 'not NAME=value' });
      continue;
    }
    const name = line.slice(0, eq).trim();
    if (!NAME.test(name)) {
      problems.push({ line: lineNo, name: name.slice(0, 64), reason: 'a name must be UPPER_SNAKE_CASE' });
      continue;
    }

    let rest = line.slice(eq + 1).trim();
    let value;
    const quote = rest[0];
    if (quote === '"' || quote === "'") {
      // The closing quote: the first one not escaped (single quotes have no escapes).
      let end = -1;
      for (let i = 1; i < rest.length; i += 1) {
        if (quote === '"' && rest[i] === '\\') { i += 1; continue; }
        if (rest[i] === quote) { end = i; break; }
      }
      if (end === -1) {
        problems.push({ line: lineNo, name, reason: 'the quote is never closed' });
        continue;
      }
      const body = rest.slice(1, end);
      value = quote === '"' ? unquoteDouble(body) : body;
      const after = rest.slice(end + 1).trim();
      if (after && !after.startsWith('#')) {
        problems.push({ line: lineNo, name, reason: 'text after the closing quote' });
        continue;
      }
    } else {
      // An unquoted value ends at " #" (a comment); a "#" inside the value stays.
      const comment = rest.search(/\s#/);
      if (comment !== -1) rest = rest.slice(0, comment);
      value = rest.trim();
    }

    if (entries.has(name)) duplicates.add(name);
    entries.set(name, { name, value, line: lineNo });
  }

  return {
    entries: [...entries.values()],
    problems,
    duplicates: [...duplicates],
  };
}

module.exports = { parseEnvText, NAME_PATTERN: NAME };
