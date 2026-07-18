/**
 * CSV serialization that is safe against spreadsheet formula injection (§10).
 *
 * A cell whose text begins with =, +, -, @ (or a leading tab / carriage return)
 * is interpreted as a formula by Excel / Google Sheets and can execute when the
 * file is opened. We neutralize those cells by prefixing a single quote, and we
 * quote any cell containing a comma, quote or newline per RFC 4180.
 */
'use strict';

const FORMULA_LEAD = /^[=+\-@\t\r]/;

/** One CSV cell: formula-neutralized, then RFC-4180 quoted when needed. */
function csvCell(value) {
  let s = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? '');
  if (FORMULA_LEAD.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows (array of objects) → CSV text with a header row from the first row's keys. */
function toCsv(rows) {
  const keys = rows.length ? Object.keys(rows[0]) : [];
  return [
    keys.map(csvCell).join(','),
    ...rows.map((r) => keys.map((k) => csvCell(r[k])).join(',')),
  ].join('\n');
}

module.exports = { csvCell, toCsv, FORMULA_LEAD };
