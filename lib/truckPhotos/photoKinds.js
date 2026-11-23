'use strict';

/**
 * What a hand-over photo shows, and where in the PDF that puts it. Pure.
 *
 * THE OWNER'S RULE (23 November 2026, after an OUTBOUND PDF of 39 photos held
 * 11 of the truck, 26 of the papers in the truck's binder and a pizza order):
 *
 *   - THE TRUCK goes in: outside, cab, dashboard, tyres, damage, any part.
 *   - WENZE'S OWN HAND-OVER FORM goes in too, on its own pages AT THE END
 *     ("Truck Equipment & Check-In Form", filled in and signed).
 *   - EVERY OTHER PAPER IS LEFT OUT, always: permits, registration, insurance,
 *     IFTA, manuals, inspection reports, a blank form, a receipt. And so are
 *     screenshots, selfies and anything not about the truck.
 *
 * A model only SORTS; this decides. A photo is left out only when the model is
 * sure (EXCLUDE_CONFIDENCE) that it is one of the leave-out kinds; a photo it
 * is unsure about, or did not answer for, or that no model could look at,
 * stays with the truck photos — an extra photo costs a page, a missing one
 * costs the evidence.
 */

/** Kinds that are the truck (or trailer) itself. */
const TRUCK_KINDS = Object.freeze([
  'truck_outside', 'cab_inside', 'dashboard', 'tires_wheels', 'damage', 'truck_part',
]);
const FORM_KIND = 'handover_form';
/** Kinds that are never the truck. */
const LEAVE_OUT_KINDS = Object.freeze(['document', 'screenshot', 'person', 'other']);
const ALL_KINDS = Object.freeze([...TRUCK_KINDS, FORM_KIND, ...LEAVE_OUT_KINDS]);

/** A photo is left out only when the model is at least this sure it is not the truck. */
const EXCLUDE_CONFIDENCE = 80;
/** A photo goes to the hand-over form pages when the model is at least this sure. */
const FORM_CONFIDENCE = 70;

const PLACEMENT = Object.freeze({ TRUCK: 'truck', FORM: 'form', LEFT_OUT: 'left_out' });

/** Words for the cover, singular and plural. */
const KIND_WORDS = Object.freeze({
  document: ['document', 'documents'],
  screenshot: ['screenshot', 'screenshots'],
  person: ['photo of a person', 'photos of people'],
  other: ['other photo', 'other photos'],
});

function confidenceOf(value) {
  const n = Number(String(value ?? '').replace('%', ''));
  if (!Number.isFinite(n)) return null;
  return n > 0 && n <= 1 ? n * 100 : n;
}

function kindOf(value) {
  const kind = String(value || '').trim().toLowerCase();
  return ALL_KINDS.includes(kind) ? kind : null;
}

/**
 * One photo's place in the PDF.
 *
 * @param {{kind?: string|null, confidence?: number|string|null}|null} verdict  null: nobody looked
 * @returns {'truck'|'form'|'left_out'}
 */
function placementOf(verdict) {
  const kind = kindOf(verdict?.kind);
  const sure = confidenceOf(verdict?.confidence) ?? 0;
  if (kind && LEAVE_OUT_KINDS.includes(kind) && sure >= EXCLUDE_CONFIDENCE) return PLACEMENT.LEFT_OUT;
  if (kind === FORM_KIND && sure >= FORM_CONFIDENCE) return PLACEMENT.FORM;
  return PLACEMENT.TRUCK;
}

/**
 * "25 documents, 1 screenshot" — the left-out kinds, most first. Empty string
 * for none.
 *
 * @param {Array<string>} kinds  the kind of each left-out photo
 */
function leftOutSummary(kinds = []) {
  const counts = new Map();
  for (const raw of kinds) {
    const kind = LEAVE_OUT_KINDS.includes(raw) ? raw : 'other';
    counts.set(kind, (counts.get(kind) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || LEAVE_OUT_KINDS.indexOf(a[0]) - LEAVE_OUT_KINDS.indexOf(b[0]))
    .map(([kind, n]) => `${n} ${KIND_WORDS[kind][n === 1 ? 0 : 1]}`)
    .join(', ');
}

module.exports = {
  TRUCK_KINDS,
  FORM_KIND,
  LEAVE_OUT_KINDS,
  ALL_KINDS,
  EXCLUDE_CONFIDENCE,
  FORM_CONFIDENCE,
  PLACEMENT,
  confidenceOf,
  kindOf,
  placementOf,
  leftOutSummary,
};
