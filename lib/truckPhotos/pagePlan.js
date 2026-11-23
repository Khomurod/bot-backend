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
 */

const { chunk } = require('./chunk');
const { PLACEMENT, placementOf, leftOutSummary } = require('./photoKinds');

/**
 * @param {object} args
 * @param {Array<object>} args.ready  the downloaded photos, in order
 * @param {Array<{kind, what, confidence}|null>} [args.verdicts]  one per `ready` item
 * @param {number} args.maxPerPdf
 * @returns {{truck: Array, forms: Array, leftOut: Array, unchecked: number,
 *   parts: Array<Array>, leftOutText: string}}
 *   each entry is the `ready` item plus its `verdict`; `parts` holds the truck
 *   photos only — the forms go after the last part's photos
 */
function planPages({ ready = [], verdicts = [], maxPerPdf }) {
  const truck = [];
  const forms = [];
  const leftOut = [];
  let unchecked = 0;
  ready.forEach((item, i) => {
    const verdict = verdicts[i] || null;
    if (!verdict) unchecked += 1;
    const entry = { ...item, verdict };
    const place = placementOf(verdict);
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
    leftOutText: leftOutSummary(leftOut.map((e) => e.verdict?.kind)),
  };
}

module.exports = { planPages };
