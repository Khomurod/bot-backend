'use strict';

/**
 * Shared server-side pagination for Trailer Department lists (PURE helpers).
 *
 * Every paginated endpoint answers {items, page, page_size, total}. Existing
 * consumers that read a legacy key (rentals/trailers/invoices/… arrays) keep
 * working: routes add the legacy key alongside via withLegacyKey().
 */

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 200;

/** Normalize page/page_size query input. */
function pageArgs(query = {}) {
  const page = Math.max(Number(query.page) || 1, 1);
  const pageSize = Math.min(
    Math.max(Number(query.page_size ?? query.pageSize) || DEFAULT_PAGE_SIZE, 1),
    MAX_PAGE_SIZE,
  );
  return { page, pageSize, offset: (page - 1) * pageSize, limit: pageSize };
}

/** Standard paginated envelope. */
function paginated(items, { page, pageSize }, total) {
  return { items, page, page_size: pageSize, total: Number(total) };
}

/** Envelope plus the legacy array key existing pages still read. */
function withLegacyKey(envelope, legacyKey) {
  return { ...envelope, [legacyKey]: envelope.items };
}

module.exports = { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, pageArgs, paginated, withLegacyKey };
