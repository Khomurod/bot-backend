'use strict';

/**
 * Do two truck numbers name the same truck? Pure.
 *
 * Exactly the same, after trimming and upper-casing — "027" and "27" are two
 * trucks (27 RUSLAN is an owner's, 027 a company truck) — or one is the other
 * written in full with a letter after it: "001A" for "001", because the chat
 * title reader keeps digits only (lib/drivers/driverGroupTitle.js) and a board
 * truck number may carry a letter (docs/architecture/dispatcher-board.md).
 */

const key = (unit) => String(unit ?? '').trim().toUpperCase();

/** "001A" is "001" with a letter after it: the same truck, written in full. */
function isFullerSpelling(full, short) {
  const f = key(full);
  const s = key(short);
  return Boolean(s) && f.length === s.length + 1 && f.startsWith(s) && /[A-Z]$/.test(f);
}

function sameUnitNumber(a, b) {
  const left = key(a);
  const right = key(b);
  if (!left || !right) return false;
  return left === right || isFullerSpelling(left, right) || isFullerSpelling(right, left);
}

module.exports = { unitKey: key, isFullerSpelling, sameUnitNumber };
