'use strict';

/**
 * What a person's answer to a hand-over PDF may change, and how. Pure.
 *
 * THE OWNER, 23 November 2026: the person who gets the PDFs (and the people
 * listed in Settings → Truck Photos) answers the PDF in their own words, and
 * Wenze rebuilds it at once. A model READS the answer into a closed list of
 * actions; nothing outside the list can happen, and every value is checked
 * here before it is used:
 *
 *   truck_number   the number on the cover ("027") — digits, one letter after
 *   kind           outbound ↔ inbound
 *   remove         photos by the label the model was shown (P11, F1, V2)
 *   restore        photos left out (L3) put back
 *   restore_kind   every left-out photo of a kind put back ("the documents too")
 *   recheck        sort the photos again (the owner's example: "go through the
 *                  chat again and pick the real photos of the truck")
 *   time_window    the photos from one time to another (Chicago), at most a day
 *   only_from      only the photos these people sent
 *   not_from       none of the photos these people sent
 *   cancel         this was not a hand-over at all — alone, never with others
 *
 * The labels are the ones the person saw: "Photo 11 of 39" is P11, a page of
 * the hand-over form F1; L1… are the photos left out, and V1… the videos, in
 * the order they were sent. An answer naming a label that does not exist, a
 * value that does not fit, or an action not in the list is NOT UNDERSTOOD —
 * never partly applied.
 */

const { DateTime } = require('luxon');
const { LEAVE_OUT_KINDS, FORM_KIND, PLACEMENT } = require('./photoKinds');

const ZONE = 'America/Chicago';
const ACTIONS = Object.freeze([
  'truck_number', 'kind', 'remove', 'restore', 'restore_kind', 'recheck', 'time_window', 'only_from', 'not_from', 'cancel',
]);
const MAX_ACTIONS = 6;
const MAX_WINDOW_HOURS = 24;
const MAX_NAMES = 5;
/** A correction must be at least this sure; anything less is a question back. */
const CONFIDENT = 70;
const UNIT = /^\d{1,6}[A-Z]?$/;
const LABEL = /^([PFLV])(\d{1,3})$/;

/**
 * Label every item of the version the person saw.
 *
 * @param {Array<{place, position, photo, verdict}>} items  in the order sent
 * @returns {Map<string, object>} label → item
 */
function labelItems(items = []) {
  const labels = new Map();
  let left = 0;
  let video = 0;
  for (const item of items) {
    if (item.place === 'truck' && item.position) labels.set(`P${item.position}`, item);
    else if (item.place === 'form' && item.position) labels.set(`F${item.position}`, item);
    else if (item.place === 'left_out') { left += 1; labels.set(`L${left}`, item); }
    else if (item.place === 'video') { video += 1; labels.set(`V${video}`, item); }
  }
  return labels;
}

function chicago(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? DateTime.fromJSDate(date).setZone(ZONE) : null;
}

/** One line per label, for the model: "P3 | Nov 19 3:26 PM | Marco Jose | truck_outside". */
function labelLines(labels) {
  return [...labels.entries()].map(([label, item]) => {
    const at = chicago(item.photo?.sentAt);
    const kind = item.place === 'video' ? 'video' : (item.verdict?.kind || 'not checked');
    return `${label} | ${at ? at.toFormat('LLL d h:mm a') : 'time unknown'} | ${item.photo?.fromName || 'unknown'} | ${kind}`;
  });
}

function parseTime(text) {
  const dt = DateTime.fromFormat(String(text || '').trim(), 'yyyy-MM-dd HH:mm', { zone: ZONE });
  return dt.isValid ? dt : null;
}

function names(list) {
  if (!Array.isArray(list) || !list.length || list.length > MAX_NAMES) return null;
  const out = list.map((n) => String(n ?? '').replace(/\s+/g, ' ').trim()).filter((n) => n && n.length <= 60);
  return out.length === list.length ? out : null;
}

function labelsOf(list, allowed, labels) {
  if (!Array.isArray(list) || !list.length || list.length > 240) return null;
  const out = [];
  for (const raw of list) {
    const label = String(raw ?? '').trim().toUpperCase();
    const m = label.match(LABEL);
    if (!m || !allowed.includes(m[1]) || !labels.has(label)) return null;
    if (!out.includes(label)) out.push(label);
  }
  return out;
}

/** One action, checked; null when it does not fit. */
function checkAction(raw, { labels, now }) {
  const type = String(raw?.do ?? '').trim().toLowerCase();
  if (!ACTIONS.includes(type)) return null;
  switch (type) {
    case 'truck_number': {
      const unit = String(raw.unit ?? '').trim().toUpperCase().replace(/^#/, '');
      return UNIT.test(unit) ? { do: type, unit } : null;
    }
    case 'kind': {
      const kind = String(raw.kind ?? '').trim().toLowerCase();
      return kind === 'outbound' || kind === 'inbound' ? { do: type, kind } : null;
    }
    case 'remove': {
      const photos = labelsOf(raw.photos, ['P', 'F', 'V'], labels);
      return photos ? { do: type, photos } : null;
    }
    case 'restore': {
      const photos = labelsOf(raw.photos, ['L'], labels);
      return photos ? { do: type, photos } : null;
    }
    case 'restore_kind': {
      const kind = String(raw.kind ?? '').trim().toLowerCase();
      return LEAVE_OUT_KINDS.includes(kind) ? { do: type, kind } : null;
    }
    case 'time_window': {
      const from = parseTime(raw.from);
      const until = parseTime(raw.until);
      if (!from || !until || until <= from) return null;
      if (until.diff(from, 'hours').hours > MAX_WINDOW_HOURS) return null;
      if (until.toMillis() > now + 10 * 60_000) return null;
      return { do: type, from: from.toUTC().toISO(), until: until.toUTC().toISO() };
    }
    case 'only_from':
    case 'not_from': {
      const senders = names(raw.senders);
      return senders ? { do: type, senders } : null;
    }
    default:
      return { do: type };
  }
}

/**
 * The model's answer, checked against what the person saw.
 *
 * @returns {{ok: true, actions: object[]} | {ok: false, question: string|null}}
 */
function checkCorrection(parsed, { labels = new Map(), now = Date.now() } = {}) {
  const question = String(parsed?.question ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) || null;
  const sure = Number(parsed?.confidence);
  const understood = parsed?.understood === true || String(parsed?.understood).toLowerCase() === 'true';
  const list = Array.isArray(parsed?.actions) ? parsed.actions : [];
  if (!understood || !(sure >= CONFIDENT) || !list.length || list.length > MAX_ACTIONS) return { ok: false, question };
  const actions = list.map((a) => checkAction(a, { labels, now }));
  if (actions.some((a) => !a)) return { ok: false, question };
  if (actions.some((a) => a.do === 'cancel') && actions.length > 1) return { ok: false, question };
  return { ok: true, actions };
}

const without = (list, ids) => (Array.isArray(list) ? list : []).filter((id) => !ids.includes(id));
const withAll = (list, ids) => [...new Set([...(Array.isArray(list) ? list : []), ...ids])];
const WORD = { outbound: 'OUTBOUND', inbound: 'INBOUND' };

/**
 * The corrections so far, plus these actions: the new `edits`, the report's
 * kind, and what changed in words (for the caption — never the person's text).
 *
 * @returns {{edits: object, kind: string, cancel: boolean, recheck: boolean, summary: string[]}}
 */
function applyActions(edits = {}, actions = [], { labels = new Map(), kind = 'outbound', shownUnit = null } = {}) {
  const next = { ...edits };
  let nextKind = kind;
  let cancel = false;
  let recheck = false;
  const summary = [];
  const idsOf = (photoLabels) => photoLabels.map((l) => labels.get(l)?.photo?.id).filter(Number.isInteger);
  for (const action of actions) {
    if (action.do === 'truck_number') {
      next.unit = action.unit;
      summary.push(String(shownUnit || '').toUpperCase() === action.unit
        ? `truck number ${action.unit} confirmed`
        : `truck number ${shownUnit || 'not on record'} -> ${action.unit}`);
    } else if (action.do === 'kind') {
      if (action.kind !== nextKind) summary.push(`${WORD[action.kind]}, not ${WORD[nextKind]}`);
      nextKind = action.kind;
    } else if (action.do === 'remove') {
      const ids = idsOf(action.photos);
      next.removed = withAll(next.removed, ids);
      next.restored = without(next.restored, ids);
      summary.push(`${ids.length} removed (${action.photos.join(', ')})`);
    } else if (action.do === 'restore') {
      const ids = idsOf(action.photos);
      next.restored = withAll(next.restored, ids);
      next.removed = without(next.removed, ids);
      summary.push(`${ids.length} put back`);
    } else if (action.do === 'restore_kind') {
      next.restoreKinds = withAll(next.restoreKinds, [action.kind]);
      summary.push(`${action.kind === 'other' ? 'other photos' : `${action.kind}s`} put back`);
    } else if (action.do === 'recheck') {
      recheck = true;
      summary.push('photos sorted again');
    } else if (action.do === 'time_window') {
      next.window = { from: action.from, until: action.until };
      const from = chicago(action.from);
      const until = chicago(action.until);
      summary.push(`photos from ${from.toFormat('LLL d h:mm a')} to ${until.toFormat('LLL d h:mm a')}`);
    } else if (action.do === 'only_from') {
      next.onlyFrom = action.senders;
      delete next.notFrom;
      summary.push(`only photos sent by ${action.senders.join(', ')}`);
    } else if (action.do === 'not_from') {
      next.notFrom = action.senders;
      delete next.onlyFrom;
      summary.push(`no photos sent by ${action.senders.join(', ')}`);
    } else if (action.do === 'cancel') {
      cancel = true;
      summary.push('cancelled - not a hand-over');
    }
  }
  return {
    edits: next, kind: nextKind, cancel, recheck, summary,
  };
}

const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/** The candidates a person's sender choice keeps. */
function bySenders(photos, edits = {}) {
  if (Array.isArray(edits.onlyFrom) && edits.onlyFrom.length) {
    return photos.filter((p) => edits.onlyFrom.some((n) => sameName(n, p.fromName)));
  }
  if (Array.isArray(edits.notFrom) && edits.notFrom.length) {
    return photos.filter((p) => !edits.notFrom.some((n) => sameName(n, p.fromName)));
  }
  return photos;
}

/**
 * Where a person's corrections put a photo, over the model's sort: removed is
 * left out; put back is the truck (or the form, when it is the form); a kind
 * put back is the truck. Null: the rules decide (lib/truckPhotos/photoKinds.js).
 */
function forcedPlace(photoId, verdict, edits = {}) {
  if ((edits.removed || []).includes(photoId)) return PLACEMENT.LEFT_OUT;
  if ((edits.restored || []).includes(photoId)) return verdict?.kind === FORM_KIND ? PLACEMENT.FORM : PLACEMENT.TRUCK;
  if (verdict?.kind && (edits.restoreKinds || []).includes(verdict.kind)) return PLACEMENT.TRUCK;
  return null;
}

module.exports = {
  ACTIONS,
  CONFIDENT,
  MAX_WINDOW_HOURS,
  labelItems,
  labelLines,
  checkCorrection,
  applyActions,
  bySenders,
  forcedPlace,
};
