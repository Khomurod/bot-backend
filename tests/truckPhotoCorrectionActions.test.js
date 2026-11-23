'use strict';

/**
 * lib/truckPhotos/correctionActions.js — what a person's answer to a hand-over
 * PDF may change (the owner, 23 November 2026). A model reads the answer into
 * actions from a closed list; here every one is checked against what the
 * person saw, and an answer with ONE thing wrong is not understood at all —
 * never partly done. Names and ids are made up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  labelItems, labelLines, checkCorrection, applyActions, bySenders, forcedPlace,
} = require('../lib/truckPhotos/correctionActions');

const AT = (h, m = 0) => new Date(Date.UTC(2026, 10, 19, h + 6, m)); // Chicago is UTC-6 in November
const item = (id, place, position, kind = 'truck_outside', from = 'Marco Jose', at = AT(15, 26)) => ({
  place, position, verdict: kind ? { kind, confidence: 95 } : null, photo: { id, fromName: from, sentAt: at },
});
const ITEMS = [
  item(1, 'truck', 1), item(2, 'truck', 2), item(3, 'left_out', null, 'document', 'Eddy Murphy', AT(17, 53)),
  item(4, 'form', 1, 'handover_form', 'Eddy Murphy', AT(17, 52)), item(5, 'left_out', null, 'screenshot', 'Eddy Murphy', AT(19, 38)),
  item(6, 'video', 1, null),
];
const labels = labelItems(ITEMS);
const NOW = Date.parse('2026-11-23T18:00:00Z');
const ok = (actions, extra = {}) => checkCorrection({ understood: true, confidence: 90, actions, ...extra }, { labels, now: NOW });

test('the labels are what the person saw: P by the PDF number, F the form, L the left-out, V the videos', () => {
  assert.deepEqual([...labels.keys()], ['P1', 'P2', 'L1', 'F1', 'L2', 'V1']);
  const lines = labelLines(labels);
  assert.equal(lines[0], 'P1 | Nov 19 3:26 PM | Marco Jose | truck_outside');
  assert.equal(lines[2], 'L1 | Nov 19 5:53 PM | Eddy Murphy | document');
  assert.match(lines[5], /^V1 \| .* \| video$/);
});

test('each action, checked: a truck number, a kind, labels that exist, a kind to put back, a window, names', () => {
  assert.deepEqual(ok([{ do: 'truck_number', unit: '#027' }]).actions, [{ do: 'truck_number', unit: '027' }]);
  assert.deepEqual(ok([{ do: 'KIND', kind: 'Inbound' }]).actions, [{ do: 'kind', kind: 'inbound' }]);
  assert.deepEqual(ok([{ do: 'remove', photos: ['p2', 'F1', 'P2'] }]).actions, [{ do: 'remove', photos: ['P2', 'F1'] }]);
  assert.deepEqual(ok([{ do: 'restore', photos: ['L1'] }]).actions, [{ do: 'restore', photos: ['L1'] }]);
  assert.deepEqual(ok([{ do: 'restore_kind', kind: 'document' }]).actions, [{ do: 'restore_kind', kind: 'document' }]);
  assert.deepEqual(ok([{ do: 'recheck' }]).actions, [{ do: 'recheck' }]);
  assert.deepEqual(ok([{ do: 'time_window', from: '2026-11-19 15:00', until: '2026-11-19 18:00' }]).actions, [
    { do: 'time_window', from: '2026-11-19T21:00:00.000Z', until: '2026-11-20T00:00:00.000Z' },
  ], 'Chicago times');
  assert.deepEqual(ok([{ do: 'only_from', senders: [' Marco  Jose '] }]).actions, [{ do: 'only_from', senders: ['Marco Jose'] }]);
  assert.deepEqual(ok([{ do: 'cancel' }]).actions, [{ do: 'cancel' }]);
});

test('ONE thing wrong is not understood — nothing partly done — and the model\'s question is kept', () => {
  const bad = [
    [{ do: 'truck_number', unit: '0270000' }],
    [{ do: 'truck_number', unit: 'twenty-seven' }],
    [{ do: 'kind', kind: 'return' }],
    [{ do: 'remove', photos: ['P99'] }], // not in the PDF
    [{ do: 'remove', photos: ['L1'] }], // left out already: that is "restore"
    [{ do: 'restore', photos: ['P1'] }],
    [{ do: 'restore_kind', kind: 'truck_outside' }],
    [{ do: 'time_window', from: '2026-11-19 18:00', until: '2026-11-19 15:00' }],
    [{ do: 'time_window', from: '2026-11-18 10:00', until: '2026-11-19 18:00' }], // more than a day
    [{ do: 'time_window', from: '2026-11-24 10:00', until: '2026-11-24 12:00' }], // in the future
    [{ do: 'delete_everything' }],
    [{ do: 'cancel' }, { do: 'recheck' }], // cancel goes alone
    [{ do: 'truck_number', unit: '027' }, { do: 'remove', photos: ['P7'] }],
    [],
  ];
  for (const actions of bad) {
    assert.equal(ok(actions).ok, false, JSON.stringify(actions));
  }
  const unsure = checkCorrection({ understood: true, confidence: 50, actions: [{ do: 'recheck' }] }, { labels, now: NOW });
  assert.equal(unsure.ok, false, 'not sure enough');
  const asked = checkCorrection({ understood: false, actions: [], question: 'Which   photos?' }, { labels, now: NOW });
  assert.deepEqual(asked, { ok: false, question: 'Which photos?' });
});

test('applying: the edits grow, removing and putting back undo each other, and the summary is Wenze\'s words', () => {
  const first = applyActions({}, [
    { do: 'truck_number', unit: '027' }, { do: 'remove', photos: ['P2'] }, { do: 'kind', kind: 'inbound' },
  ], { labels, kind: 'outbound', shownUnit: '088' });
  assert.deepEqual(first.edits, { unit: '027', removed: [2], restored: [] });
  assert.equal(first.kind, 'inbound');
  assert.deepEqual(first.summary, ['truck number 088 -> 027', '1 removed (P2)', 'INBOUND, not OUTBOUND']);

  const second = applyActions(first.edits, [{ do: 'restore', photos: ['L1'] }, { do: 'recheck' }], { labels, kind: 'inbound' });
  assert.deepEqual(second.edits.restored, [3]);
  assert.equal(second.recheck, true);
  assert.equal(second.edits.recheck, undefined, '"look again" is for this rebuild only');

  const back = applyActions(first.edits, [{ do: 'restore', photos: ['L1'] }], { labels });
  assert.deepEqual(back.edits.removed, [2]);
  assert.equal(applyActions({}, [{ do: 'cancel' }], { labels }).cancel, true);
  assert.deepEqual(applyActions({}, [{ do: 'truck_number', unit: '027' }], { labels, shownUnit: '027' }).summary,
    ['truck number 027 confirmed'], 'the number the cover already showed');
});

test('a person outranks the model: removed is out, put back is in (the form stays the form), a kind put back is in', () => {
  const edits = { removed: [1], restored: [3, 4], restoreKinds: ['screenshot'] };
  assert.equal(forcedPlace(1, { kind: 'truck_outside' }, edits), 'left_out');
  assert.equal(forcedPlace(3, { kind: 'document' }, edits), 'truck');
  assert.equal(forcedPlace(4, { kind: 'handover_form' }, edits), 'form');
  assert.equal(forcedPlace(5, { kind: 'screenshot' }, edits), 'truck');
  assert.equal(forcedPlace(2, { kind: 'document' }, edits), null, 'the rules decide');
});

test('only from / not from a sender, by name, any letter case', () => {
  const photos = [{ id: 1, fromName: 'Marco Jose' }, { id: 2, fromName: 'Eddy Murphy' }, { id: 3, fromName: null }];
  assert.deepEqual(bySenders(photos, { onlyFrom: ['marco jose'] }).map((p) => p.id), [1]);
  assert.deepEqual(bySenders(photos, { notFrom: ['EDDY MURPHY'] }).map((p) => p.id), [1, 3]);
  assert.deepEqual(bySenders(photos, {}).map((p) => p.id), [1, 2, 3]);
});
