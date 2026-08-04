/**
 * What a trailer's status IS — the vocabulary shared by every reader.
 *
 * Pure functions and constants only: no SQL, no pool. Possession and cargo are
 * normalized here so the Telegram ingest path, the admin lists, and the map can
 * never disagree about what "dropped" or "loaded" means.
 */


/**
 * What makes a trailer a real, official asset — the single definition shared by
 * every list, map and picker (`t` must be the trailers alias).
 *
 * Two independent flags must BOTH hold: `active` is the legacy soft-delete, and
 * `master_status` is master-list authority. A pending-review, archived or merged
 * trailer is not an asset: it keeps its history but must never appear on a map,
 * in a default list, or in a rental picker.
 */
const OFFICIAL_TRAILER_PREDICATE = "t.active = TRUE AND t.master_status = 'active'";

const POSSESSION_STATES = new Set(['with_driver', 'dropped', 'unknown']);
const CARGO_STATES = new Set(['empty', 'loaded', 'unknown']);
/** Coerce to a valid possession_status; unknown for anything unexpected. */
function normPossession(value) {
  const t = String(value || '').trim().toLowerCase();
  return POSSESSION_STATES.has(t) ? t : 'unknown';
}
/** Coerce to a valid cargo_status; unknown for anything unexpected. */
function normCargo(value) {
  const t = String(value || '').trim().toLowerCase();
  return CARGO_STATES.has(t) ? t : 'unknown';
}
/** Map an event_type to its possession_status (fallback when none was stored). */
function possessionForEventType(eventType) {
  if (eventType === 'pickup') return 'with_driver';
  if (eventType === 'dropoff') return 'dropped';
  return 'unknown';
}
/**
 * Derive the possession + cargo for the current-status row from an event. Honors
 * the event's stored possession_status/cargo_status when present; otherwise falls
 * back to the action (dropoff ⇒ dropped/empty, pickup ⇒ with_driver/unknown) so
 * pre-cargo historical events still resolve sensibly.
 */
function derivePossessionCargo(event) {
  const possession = event.possession_status
    ? normPossession(event.possession_status)
    : possessionForEventType(event.event_type);
  let cargo = normCargo(event.cargo_status);
  if (cargo === 'unknown' && !event.cargo_status && event.event_type === 'dropoff') {
    cargo = 'empty'; // dropped ⇒ empty by default (business rule)
  }
  return { possession, cargo };
}

const POSSESSION_LABEL = { with_driver: 'With driver', dropped: 'Dropped', unknown: 'Unknown' };
const CARGO_LABEL = { empty: 'Empty', loaded: 'Loaded', unknown: 'Unknown cargo' };

/**
 * Human display status, e.g. "Dropped / Empty", "With driver / Loaded".
 * needsReview overrides to "Unknown / Needs review" only when possession is
 * unknown, matching the task's status vocabulary.
 */
function buildDisplayStatus(possession, cargo, needsReview) {
  const p = normPossession(possession);
  const c = normCargo(cargo);
  if (p === 'unknown') return needsReview ? 'Unknown / Needs review' : 'Unknown';
  const cargoLabel = c === 'unknown' ? 'Unknown cargo' : CARGO_LABEL[c];
  return `${POSSESSION_LABEL[p]} / ${cargoLabel}`;
}


module.exports = {
  OFFICIAL_TRAILER_PREDICATE,
  POSSESSION_STATES,
  CARGO_STATES,
  normPossession,
  normCargo,
  possessionForEventType,
  derivePossessionCargo,
  buildDisplayStatus,
};
