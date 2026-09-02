/**
 * Pure agreement-status derivation.
 *
 * An agreement's status is a function of its items' statuses — never set
 * directly. Keeping it pure means it can be unit-tested exhaustively and called
 * inside the same transaction as any item transition without touching I/O.
 *
 * Documented rules (first match wins):
 *   - explicit terminal overrides:
 *       closed    → the agreement was explicitly closed
 *       cancelled → every item is cancelled/removed before pickup
 *   - disputed   → any item is disputed (disputes surface loudly)
 *   - no live items at all (all cancelled/removed/replaced) → cancelled
 *   - draft      → every live item is still draft
 *   - scheduled  → every live item is scheduled/ready, none active/returned yet
 *   - active     → every live item is active
 *   - returned   → every live item is returned
 *   - partially_active   → some active, the rest still scheduled/draft
 *   - partially_returned → some returned, some still active/scheduled
 */
'use strict';

const TERMINAL_ITEM = new Set(['cancelled', 'removed_before_pickup', 'replaced']);

/**
 * @param {Array<{item_status?: string, itemStatus?: string}>} items
 * @param {object} [opts]
 * @param {boolean} [opts.explicitClosed] agreement was explicitly closed
 * @returns {string} agreement status
 */
function deriveAgreementStatus(items = [], opts = {}) {
  if (opts.explicitClosed) return 'closed';

  const statuses = (items || [])
    .map((it) => (it.item_status || it.itemStatus || '').trim())
    .filter(Boolean);

  if (statuses.length === 0) return 'draft';

  // A dispute anywhere dominates so it is never hidden behind an aggregate.
  if (statuses.includes('disputed')) return 'disputed';

  const live = statuses.filter((s) => !TERMINAL_ITEM.has(s));
  if (live.length === 0) return 'cancelled';

  const all = (pred) => live.every(pred);
  const any = (pred) => live.some(pred);

  const isActive = (s) => s === 'active';
  const isReturned = (s) => s === 'returned';
  const isScheduled = (s) => s === 'scheduled' || s === 'ready_for_pickup';
  const isDraft = (s) => s === 'draft';

  if (all(isDraft)) return 'draft';
  if (all(isReturned)) return 'returned';
  if (all(isActive)) return 'active';
  if (all((s) => isScheduled(s) || isDraft(s))) return 'scheduled';

  // Mixed live states.
  if (any(isReturned) && any((s) => isActive(s) || isScheduled(s) || isDraft(s))) {
    return 'partially_returned';
  }
  if (any(isActive)) return 'partially_active';

  return 'scheduled';
}

module.exports = { deriveAgreementStatus, TERMINAL_ITEM };
