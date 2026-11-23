'use strict';

/**
 * services/truckPhotos/uncheckedNotice.js — the owner is told, once per
 * report, when a hand-over PDF went out with photos no model looked at (the
 * owner, 23 November 2026: "send it with a mark and tell me right away").
 * Sentences only, through the one door; never throws.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { tellOwnerUnchecked, uncheckedNoticeText, CATEGORY } = require('../services/truckPhotos/uncheckedNotice');

test('one notice per report, in the system-errors category, keyed by the report', async () => {
  const sent = [];
  const out = await tellOwnerUnchecked({
    reportId: 7, kind: 'outbound', chatTitle: 'WENZE UNIT # 327 X', unchecked: 39, total: 39, stopped: 'unavailable', groupId: 3,
  }, { notify: async (n) => { sent.push(n); return { recorded: true }; } });
  assert.deepEqual(out, { notified: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].category, CATEGORY);
  assert.equal(sent[0].subjectType, 'truck_photo_report');
  assert.equal(sent[0].subjectId, '7');
  assert.equal(sent[0].groupId, 3);
  assert.equal(sent[0].title, 'Truck Photos: none of the 39 photos were checked by AI');
  assert.match(sent[0].lines.join(' '), /OUTBOUND in "WENZE UNIT # 327 X": the PDF was sent with every photo/);
  assert.match(sent[0].lines.join(' '), /no AI model that can look at pictures answered/);
  assert.match(sent[0].action, /Settings → AI/);
});

test('some unchecked, or a check that ran out of time, is said as such', () => {
  const words = uncheckedNoticeText({ kind: 'inbound', chatTitle: 'g', unchecked: 5, total: 39, stopped: 'deadline' });
  assert.equal(words.title, 'Truck Photos: 5 of 39 photos were not checked by AI');
  assert.match(words.lines[0], /^INBOUND in "g"/);
  assert.match(words.lines[1], /ran out of time/);
});

test('nothing unchecked is nothing said; a failing door never throws', async () => {
  let calls = 0;
  const notify = async () => { calls += 1; throw new Error('outbox down'); };
  assert.deepEqual(await tellOwnerUnchecked({ reportId: 1, unchecked: 0, total: 3 }, { notify }), { notified: false });
  assert.equal(calls, 0);
  assert.deepEqual(await tellOwnerUnchecked({ reportId: 1, unchecked: 2, total: 3, kind: 'outbound' }, { notify }), { notified: false });
  assert.equal(calls, 1);
});
