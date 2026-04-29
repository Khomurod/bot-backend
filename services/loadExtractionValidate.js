/**
 * Post-checks for AI-extracted load fields (reduce silent bad saves).
 */

function normalizeLine(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True if we have enough structured data to persist a load row / trust ETA routing.
 */
function hasMinimalStructuredLoad({
  pickupSummary = '',
  deliverySummary = '',
  destinationQuery = '',
} = {}) {
  const p = normalizeLine(pickupSummary);
  const d = normalizeLine(deliverySummary);
  const q = normalizeLine(destinationQuery);
  if (q.length >= 5) return true;
  if (p.length >= 4 && d.length >= 4) return true;
  return false;
}

/**
 * True if raw AI field object looks usable before merging into summaries.
 */
function groqFieldsLookComplete(fields) {
  if (!fields || typeof fields !== 'object') return false;
  const p = normalizeLine(fields.pickupLocation || '');
  const d = normalizeLine(fields.deliveryLocation || '');
  const q = normalizeLine(fields.destinationQuery || '');
  if (q.length >= 5) return true;
  return p.length >= 4 && d.length >= 4;
}

module.exports = {
  hasMinimalStructuredLoad,
  groqFieldsLookComplete,
  normalizeLine,
};
