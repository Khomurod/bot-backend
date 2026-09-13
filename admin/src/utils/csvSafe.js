/**
 * CSV serialization that is safe against spreadsheet formula injection.
 *
 * A cell whose text begins with `=`, `+`, `-`, `@` (or a leading tab or
 * carriage return) is interpreted as a FORMULA by Excel and Google Sheets, and
 * can execute when the file is opened. Prefixing a single quote neutralises it;
 * quoting per RFC 4180 handles commas, quotes and newlines.
 *
 * THE VALUES HERE COME FROM OUTSIDE THIS COMPANY. A driver row's name is read
 * out of a TELEGRAM GROUP TITLE, which anyone who can rename that group
 * chooses. A group renamed to `=HYPERLINK("http://…","click")` is a live
 * formula in the next export somebody opens.
 *
 * THIS IS THE ONE IMPLEMENTATION. `server/routes/csvSafe.js` re-exports it for
 * Node, the way `utils/birthdaySort.js` already does for its own helper. The
 * previous arrangement had two: a safe one under `server/routes/` with tests
 * and no caller at all, and an unsafe copy inside the admin panel doing the
 * only CSV export that exists — which is exactly the shape of a guard that was
 * written, proved, and then not used.
 */

const FORMULA_LEAD = /^[=+\-@\t\r]/;

/** One CSV cell: formula-neutralised, then RFC-4180 quoted when needed. */
export function csvCell(value) {
  let s = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? '');
  if (FORMULA_LEAD.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows of CELLS (arrays) → CSV text. Used where the header is explicit. */
export function csvRows(rows) {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

/** Rows (array of objects) → CSV text with a header from the first row's keys. */
export function toCsv(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  const keys = Object.keys(rows[0]);
  return [
    keys.map(csvCell).join(','),
    ...rows.map((r) => keys.map((k) => csvCell(r[k])).join(',')),
  ].join('\r\n');
}

export { FORMULA_LEAD };
