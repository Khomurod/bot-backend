'use strict';

/**
 * Splitting a hand-over's photos into PDFs Telegram will take. Pure.
 *
 * A bot may send a document of at most 50 MB. Sixty photos at ~1600 px are
 * comfortably under that, so a hand-over of more than sixty becomes several
 * PDFs, "Part 1 of 2", each a complete document with its own cover.
 */

const DEFAULT_PART_SIZE = 60;

/**
 * @param {Array} items
 * @param {number} [size]  photos per part; anything but a positive integer is 60
 * @returns {Array<Array>}  never an empty part; no items → no parts
 */
function chunk(items, size = DEFAULT_PART_SIZE) {
  const per = Number.isInteger(size) && size > 0 ? size : DEFAULT_PART_SIZE;
  const list = Array.isArray(items) ? items : [];
  const parts = [];
  for (let i = 0; i < list.length; i += per) parts.push(list.slice(i, i + per));
  return parts;
}

module.exports = { chunk, DEFAULT_PART_SIZE };
