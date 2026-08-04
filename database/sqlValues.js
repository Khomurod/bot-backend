'use strict';

/**
 * Coercions applied to values on their way INTO a SQL parameter.
 *
 * Deliberately narrow: this is not a general utility module. It exists so the
 * same coercion is not written twice — `boundedText` was copied verbatim into
 * two data-access modules before this one existed, which is exactly how the two
 * copies would eventually have disagreed about a column's real width.
 *
 * Add something here only when more than one data-access module needs the same
 * value coercion. Query building, table knowledge, and business rules belong in
 * the module that owns the table.
 */

/**
 * Trim to a bounded string, or null for empty/blank. Never throws.
 *
 * Blank becomes null rather than '' so an absent value never overwrites a
 * stored one through a COALESCE, and `max` keeps a long input from being
 * rejected by the column's own length limit.
 */
function boundedText(value, max = 500) {
  if (value == null) return null;
  const t = String(value).trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max) : t;
}

module.exports = { boundedText };
