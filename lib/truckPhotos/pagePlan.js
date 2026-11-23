'use strict';

/**
 * Which pages a hand-over PDF holds, in which order. Pure.
 *
 *   - the TRUCK photos, in the order they were sent, split into parts of
 *     `maxPerPdf` (a part is one PDF);
 *   - Wenze's own HAND-OVER FORM, on its own pages at the END of the last part
 *     (the owner, 23 November 2026);
 *   - what a model was sure is NOT the truck is left out, and only counted —
 *     "25 documents, 1 screenshot" (lib/truckPhotos/photoKinds.js).
 *
 * A photo with no verdict — no model looked at it — is a truck photo, and is
 * counted as UNCHECKED so the cover can say so.
 *
 * A PERSON'S CORRECTION OUTRANKS THE MODEL (lib/truckPhotos/correctionActions.js
 * `forcedPlace`): a photo they removed is left out, one they put back is in,
 * whatever the sort said. Such a photo is not "unchecked" — a person decided.
 */

const { chunk } = require('./chunk');
const { PLACEMENT, placementOf, leftOutSummary } = require('./photoKinds');

/**
 * @param {object} args
 * @param {Array<object>} args.ready  the downloaded photos, in order
 * @param {Array<{kind, what, confidence}|null>} [args.verdicts]  one per `ready` item
 * @param {number} args.maxPerPdf
 * @param {(item: object, verdict: object|null) => string|null} [args.forced]  a person's placement
 * @returns {{truck: Array, forms: Array, leftOut: Array, unchecked: number,
 *   parts: Array<Array>, leftOutText: string}}
 *   each entry is the `ready` item plus its `verdict`; `parts` holds the truck
 *   photos only — the forms go after the last part's photos
 */
function planPages({
  ready = [], verdicts = [], maxPerPdf, forced = null,
}) {
  const truck = [];
  const forms = [];
  const leftOut = [];
  let unchecked = 0;
  ready.forEach((item, i) => {
    const verdict = verdicts[i] || null;
    const chosen = typeof forced === 'function' ? forced(item, verdict) : null;
    if (!verdict && !chosen) unchecked += 1;
    const entry = { ...item, verdict, byPerson: Boolean(chosen) };
    const place = chosen || placementOf(verdict);
    if (place === PLACEMENT.LEFT_OUT) leftOut.push(entry);
    else if (place === PLACEMENT.FORM) forms.push(entry);
    else truck.push(entry);
  });
  return {
    truck,
    forms,
    leftOut,
    unchecked,
    parts: truck.length ? chunk(truck, maxPerPdf) : [[]],
    leftOutText: leftOutText(leftOut),
  };
}

/** "25 documents, 1 screenshot" for the model's; "3 removed by hand" for a person's. */
function leftOutText(leftOut) {
  const byModel = leftOutSummary(leftOut.filter((e) => !e.byPerson).map((e) => e.verdict?.kind));
  const byHand = leftOut.filter((e) => e.byPerson).length;
  return [byModel, byHand ? `${byHand} removed by hand` : ''].filter(Boolean).join(', ');
}

/**
 * What a version held, to remember (`truck_photo_report_items`): each photo's
 * place and its number in the PDF ("Photo 11" is truck 11, "Hand-over form 1"
 * is form 1), the videos in order, and how the model sorted each photo.
 */
function versionItems(plan, videos = []) {
  const item = (entry, place, position) => ({
    photoId: entry.photo.id,
    place,
    position,
    kind: entry.verdict?.kind ?? null,
    confidence: entry.verdict?.confidence ?? null,
  });
  return [
    ...plan.truck.map((e, i) => item(e, 'truck', i + 1)),
    ...plan.forms.map((e, i) => item(e, 'form', i + 1)),
    ...plan.leftOut.map((e) => item(e, 'left_out', null)),
    ...videos.map((v, i) => ({
      photoId: v.id, place: 'video', position: i + 1, kind: null, confidence: null,
    })),
  ].filter((i) => Number.isInteger(i.photoId));
}

module.exports = { planPages, versionItems };
