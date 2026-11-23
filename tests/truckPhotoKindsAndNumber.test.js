'use strict';

/**
 * The owner's two rules of 23 November 2026, pure:
 *
 *   - lib/truckPhotos/photoKinds.js + pagePlan.js: the truck in, Wenze's own
 *     hand-over form in at the END, every other paper (and screenshots,
 *     people, anything else) left out — but only on a sure answer; a photo
 *     nobody looked at stays in and is counted as unchecked.
 *   - lib/truckPhotos/truckNumber.js: the chat title's truck number, the
 *     profile and the Dispatcher Board named when they disagree.
 *
 * The real cases: chat "WENZE UNIT # 327 …" with a profile seeded as 326, and
 * "WENZE UNIT # 027 …" seeded as 088 while the Board showed 3731 V.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  placementOf, leftOutSummary, EXCLUDE_CONFIDENCE, FORM_CONFIDENCE,
} = require('../lib/truckPhotos/photoKinds');
const { planPages } = require('../lib/truckPhotos/pagePlan');
const { decideTruckNumber, boardTrucksNaming } = require('../lib/truckPhotos/truckNumber');
const { sameUnitNumber: sameNumber } = require('../lib/drivers/unitNumber');

const v = (kind, confidence = 95) => ({ kind, what: null, confidence });

test('only a SURE "not the truck" leaves a photo out; unsure, unknown and unseen stay with the truck', () => {
  for (const kind of ['document', 'screenshot', 'person', 'other']) {
    assert.equal(placementOf(v(kind, EXCLUDE_CONFIDENCE)), 'left_out', kind);
    assert.equal(placementOf(v(kind, EXCLUDE_CONFIDENCE - 1)), 'truck', `${kind}, not sure`);
  }
  for (const kind of ['truck_outside', 'cab_inside', 'dashboard', 'tires_wheels', 'damage', 'truck_part']) {
    assert.equal(placementOf(v(kind)), 'truck', kind);
  }
  assert.equal(placementOf(null), 'truck', 'nobody looked');
  assert.equal(placementOf(v('a pizza', 99)), 'truck', 'not one of ours');
  assert.equal(placementOf(v('handover_form', FORM_CONFIDENCE)), 'form');
  assert.equal(placementOf(v('handover_form', FORM_CONFIDENCE - 1)), 'truck', 'an unsure form stays among the photos');
  assert.equal(placementOf(v('document', '0.9')), 'left_out', 'a fraction is a percentage');
});

test('what was left out is said in words, most first', () => {
  assert.equal(leftOutSummary([]), '');
  assert.equal(leftOutSummary(['document', 'screenshot', 'document']), '2 documents, 1 screenshot');
  assert.equal(leftOutSummary(['person', 'other', 'other']), '2 other photos, 1 photo of a person');
  assert.equal(leftOutSummary(['person']), '1 photo of a person');
});

test('the plan: truck photos in order and in parts, the form after them, the rest counted, the unseen counted', () => {
  const ready = Array.from({ length: 7 }, (_, i) => ({ photo: { id: i }, jpeg: Buffer.from(String(i)) }));
  const verdicts = [v('truck_outside'), v('document'), v('handover_form'), null, v('screenshot'), v('cab_inside'), v('document', 50)];
  const plan = planPages({ ready, verdicts, maxPerPdf: 2 });
  assert.deepEqual(plan.truck.map((e) => e.photo.id), [0, 3, 5, 6]);
  assert.deepEqual(plan.parts.map((part) => part.map((e) => e.photo.id)), [[0, 3], [5, 6]]);
  assert.deepEqual(plan.forms.map((e) => e.photo.id), [2]);
  assert.deepEqual(plan.leftOut.map((e) => e.photo.id), [1, 4]);
  assert.equal(plan.unchecked, 1);
  assert.equal(plan.leftOutText, '1 document, 1 screenshot');

  const onlyForm = planPages({ ready: ready.slice(2, 3), verdicts: [v('handover_form')], maxPerPdf: 60 });
  assert.deepEqual(onlyForm.parts, [[]], 'a form alone is still one PDF');
  assert.equal(onlyForm.forms.length, 1);
});

test('the chat title\'s number wins, and the profile that disagrees is named', () => {
  assert.deepEqual(decideTruckNumber({ profileUnit: '326', titleUnit: '327' }), {
    unit: '327', source: 'title', matchesProfile: false, check: ['profile says 326'],
  });
  assert.deepEqual(decideTruckNumber({ profileUnit: '327', titleUnit: '327' }), {
    unit: '327', source: 'title', matchesProfile: true, check: [],
  });
});

test('the Board that names the driver on another truck is named too; one that agrees is not', () => {
  const frantz = decideTruckNumber({ profileUnit: '088', titleUnit: '027', boardTrucks: [{ unit: '3731', raw: '3731 V' }] });
  assert.equal(frantz.unit, '027');
  assert.deepEqual(frantz.check, ['profile says 088', 'Board says 3731 V']);
  const agrees = decideTruckNumber({ profileUnit: '326', titleUnit: '327', boardTrucks: [{ unit: '327', raw: '327 COMP' }] });
  assert.deepEqual(agrees.check, ['profile says 326']);
});

test('"001A" in the profile is the fuller spelling of the title\'s "001": the same truck, nothing to check', () => {
  const out = decideTruckNumber({ profileUnit: '001A', titleUnit: '001', boardTrucks: [{ unit: '001A', raw: '001A' }] });
  assert.deepEqual(out, { unit: '001A', source: 'profile', matchesProfile: true, check: [] });
  assert.equal(sameNumber('001', '001A'), true);
  assert.equal(sameNumber('027', '27'), false, 'a dropped zero is another truck (27 RUSLAN is an owner\'s)');
  assert.equal(sameNumber('326', '327'), false);
});

test('no number in the title: the profile; neither: the Board, when it names exactly one truck', () => {
  assert.equal(decideTruckNumber({ profileUnit: '562', titleUnit: null }).unit, '562');
  assert.equal(decideTruckNumber({ boardTrucks: [{ unit: '562', raw: '562 ERNST' }] }).unit, '562');
  assert.equal(decideTruckNumber({ boardTrucks: [{ unit: '1', raw: '1' }, { unit: '2', raw: '2' }] }).unit, null);
  assert.deepEqual(decideTruckNumber({}), { unit: null, source: null, matchesProfile: false, check: [] });
});

test('the Board lines are the ones that name THIS driver strictly — never a shared surname, never by number', () => {
  const rows = [
    { truck_norm: '3731', truck_raw: '3731 V', driver_name_clean: 'FRANTZ ARTHUS', team_members: null },
    { truck_norm: '88', truck_raw: '88 SHERZOD', driver_name_clean: 'SHERZOD ABDUEV', team_members: null },
    { truck_norm: '500', truck_raw: '500', driver_name_clean: 'JOHN ARTHUS', team_members: null },
    { truck_norm: '600', truck_raw: '600 TEAM', driver_name_clean: 'A / B', team_members: ['PAT LEE', 'FRANTZ ARTHUS'] },
    { truck_norm: '', truck_raw: '', driver_name_clean: 'FRANTZ ARTHUS', team_members: null },
  ];
  assert.deepEqual(boardTrucksNaming(rows, { first_name: 'Frantz', last_name: 'Arthus', unit_number: '088' }), [
    { unit: '3731', raw: '3731 V' }, { unit: '600', raw: '600 TEAM' },
  ]);
  assert.deepEqual(boardTrucksNaming(rows, null), []);
  assert.deepEqual(boardTrucksNaming(rows, { first_name: 'Arthus' }), [], 'one word is never a name');
});
