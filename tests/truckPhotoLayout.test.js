'use strict';

/**
 * What the truck-photo PDF and the private failure message say
 * (lib/truckPhotos/pdfLayout.js, failureText.js, pdfText.js). The cover names
 * the truck the way Wenze knows it — number, fleet, owner — in Chicago time;
 * an inbound cover names the outbound before it, or says there was none; the
 * failure message is fixed words with no link in it. Names are made up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const layout = require('../lib/truckPhotos/pdfLayout');
const { failureMessage, reasonText, REASON_CODES } = require('../lib/truckPhotos/failureText');
const { pdfSafeText } = require('../lib/truckPhotos/pdfText');

const PROFILE = {
  first_name: 'Jerome', last_name: 'Joyner', unit_number: '1', driver_type: 'company_driver',
  truck_fleet: 'owner_operator', truck_owner: 'Ernst',
};
const AT = new Date('2026-11-06T16:14:00Z'); // 10:14 AM in Chicago

const texts = (lines) => lines.map((l) => l.text);

test('an outbound cover: the driver, the truck (number, fleet, owner), the chat, Chicago time, who marked it', () => {
  const lines = texts(layout.coverLines({
    kind: 'outbound', profile: PROFILE, groupName: 'Jerome Joyner 1', triggerAt: AT, markedBy: 'Kim Rowe',
    photoCount: 42, excludedCount: 3,
  }));
  assert.equal(lines[0], 'OUTBOUND');
  assert.ok(lines.includes('Driver: Jerome Joyner'));
  assert.ok(lines.includes('Truck: 1 - Owner-Operator - owner ERNST'), lines.join(' | '));
  assert.ok(lines.includes('Chat: Jerome Joyner 1'));
  assert.ok(lines.includes('Marked: Nov 6, 2026 10:14 AM CST'), lines.join(' | '));
  assert.ok(lines.includes('Marked by: Kim Rowe'));
  assert.ok(lines.includes('Photos: 42 (excluded 3 - not the truck)'));
  assert.ok(!lines.some((l) => /Outbound on|No outbound/.test(l)), 'only an inbound names the outbound');
});

test('an inbound cover with an outbound on record names its date and photo count', () => {
  const lines = texts(layout.coverLines({
    kind: 'inbound', profile: PROFILE, groupName: 'g', triggerAt: AT, photoCount: 30,
    outbound: { at: new Date('2026-10-28T14:00:00Z'), photoCount: 38 },
  }));
  assert.equal(lines[0], 'INBOUND');
  assert.ok(lines.includes('Outbound on Oct 28, 2026, 38 photos'), lines.join(' | '));
  assert.ok(lines.includes('Photos: 30'));
});

test('an inbound cover without an outbound says so', () => {
  const lines = texts(layout.coverLines({ kind: 'inbound', profile: null, groupName: 'g', triggerAt: AT, photoCount: 5 }));
  assert.ok(lines.includes('No outbound on record'));
  assert.ok(lines.includes('Driver: not on record'));
  assert.ok(lines.some((l) => l.startsWith('Truck: number not on record')));
});

test('a team, a company truck with no owner, a part of several', () => {
  const team = { first_name: 'Ann', last_name: 'Lee', secondary_first_name: 'Bo', secondary_last_name: 'Ray', unit_number: '021', driver_type: 'company_driver' };
  const lines = texts(layout.coverLines({
    kind: 'outbound', profile: team, groupName: 'g', triggerAt: AT, photoCount: 121, part: 2, parts: 3,
    firstNumber: 61, lastNumber: 120,
  }));
  assert.ok(lines.includes('Driver: Ann Lee / Bo Ray'));
  assert.ok(lines.includes('Truck: 021 - Company'), 'leading zeros kept; no owner');
  assert.ok(lines.includes('Part 2 of 3 (photos 61-120)'));
});

test('the file name: kind, unit, Chicago date, and the part when there are several', () => {
  assert.equal(layout.fileName({ kind: 'outbound', unit: '562', at: AT }), 'outbound_562_2026-11-06.pdf');
  assert.equal(layout.fileName({ kind: 'inbound', unit: '1', at: AT, part: 1, parts: 2 }), 'inbound_1_2026-11-06_part1of2.pdf');
  assert.equal(layout.fileName({ kind: 'outbound', unit: null, at: AT }), 'outbound_no-unit_2026-11-06.pdf');
  assert.equal(layout.fileName({ kind: 'outbound', unit: '../12 A', at: AT }), 'outbound_12A_2026-11-06.pdf', 'never a path');
  // 03:30 UTC on the 7th is still the 6th in Chicago.
  assert.equal(layout.fileName({ kind: 'outbound', unit: '9', at: new Date('2026-11-07T03:30:00Z') }), 'outbound_9_2026-11-06.pdf');
});

test('a photo caption, and the caption on the document', () => {
  assert.equal(
    layout.photoCaption({ number: 3, total: 42, sentAt: AT, fromName: 'Шерзод' }),
    'Photo 3 of 42 - Nov 6, 2026 10:14 AM CST - sent by Sherzod',
  );
  const caption = layout.deliveryCaption({
    kind: 'inbound', profile: PROFILE, groupName: 'g', triggerAt: AT, photoCount: 12, part: 1, parts: 2, outbound: null,
  });
  assert.match(caption, /^INBOUND - Jerome Joyner/);
  assert.match(caption, /No outbound on record/);
  assert.match(caption, /Part 1 of 2/);
});

test('every PDF string is printable by the built-in font: Cyrillic in Latin letters, emoji gone', () => {
  assert.equal(pdfSafeText('Шерзод Ўлмасов'), "Sherzod O'lmasov");
  assert.equal(pdfSafeText('José “Pepe” O’Neal — 🚛'), 'Jose "Pepe" O\'Neal -');
  assert.equal(pdfSafeText('日本'), '??');
  for (const line of layout.coverLines({ kind: 'outbound', profile: { first_name: 'Ёқуб' }, groupName: '🚛 Группа', triggerAt: AT, photoCount: 1 })) {
    assert.match(line.text, /^[\x20-\x7e]*$/, line.text);
  }
});

test('the failure message: what, where, who, when, why and what to do — no link, no message text', () => {
  const text = failureMessage({
    code: 'unclear', kind: 'outbound', chatTitle: 'Jerome Joyner https://t.me/x?token=abc', markedBy: 'Kim Rowe', at: AT,
  });
  assert.match(text, /^Truck photos: no PDF was made\./);
  assert.match(text, /OUTBOUND in "Jerome Joyner <url>", marked by Kim Rowe, Nov 6, 2026 10:14 AM CST\./);
  assert.match(text, /Why: Wenze could not tell whether the message is about handing over or returning the truck\./);
  assert.match(text, /write just "outbound" in the group, as a reply to the photos/);
  assert.doesNotMatch(text, /https?:|t\.me|token/);
});

test('every reason has its own fixed sentence', () => {
  const seen = new Set();
  for (const code of REASON_CODES) {
    const sentence = reasonText(code, { kind: 'inbound', lookbackHours: 3, photoCount: 4, part: 2, parts: 3 });
    assert.ok(sentence.length > 10, code);
    assert.ok(!seen.has(sentence), `${code} reuses another reason's words`);
    seen.add(sentence);
  }
  assert.match(reasonText('no_photos', { lookbackHours: 3 }), /3 hours/);
  assert.match(reasonText('part_not_delivered', { part: 2, parts: 3 }), /Part 2 of 3/);
});

test('the truck the decision names: the profile\'s fleet and owner only when the number is the profile\'s', () => {
  const same = layout.truckOf(PROFILE, 'g', { unit: '1', matchesProfile: true, check: [] });
  assert.equal(same.text, '1 - Owner-Operator - owner ERNST');
  // Another number: the profile's owner belongs to the profile's truck, not this one.
  const other = layout.truckOf(PROFILE, 'g', { unit: '327', matchesProfile: false, check: ['profile says 1'] });
  assert.equal(other.text, '327 - Company (profile says 1 - please check)');
  assert.equal(other.owner, null);
  assert.equal(layout.truckOf(PROFILE, 'g').text, '1 - Owner-Operator - owner ERNST', 'no decision: the profile, as before');
});

test('photos no model looked at: big and bold on the cover, and in the caption', () => {
  const all = texts(layout.coverLines({
    kind: 'outbound', profile: PROFILE, groupName: 'g', triggerAt: AT, photoCount: 39, uncheckedCount: 39, checkedTotal: 39,
  }));
  assert.ok(all.includes('NOT CHECKED BY AI: all 39 photos.'), all.join(' | '));
  assert.ok(all.includes('No AI model could look at them, so they are all included.'));
  const some = layout.uncheckedLines(5, 39);
  assert.equal(some[0], 'NOT CHECKED BY AI: 5 of 39 photos.');
  assert.deepEqual(layout.uncheckedLines(0, 39), []);
  const caption = layout.deliveryCaption({
    kind: 'outbound', profile: PROFILE, groupName: 'g', triggerAt: AT, photoCount: 39, uncheckedCount: 39, checkedTotal: 39,
  });
  assert.match(caption, /NOT CHECKED BY AI: all 39 photos\./);
  const checked = texts(layout.coverLines({ kind: 'outbound', profile: PROFILE, groupName: 'g', triggerAt: AT, photoCount: 3 }));
  assert.ok(!checked.some((l) => /NOT CHECKED/.test(l)));
});

test('the hand-over form and what was left out, on the cover; the form\'s own caption', () => {
  const lines = texts(layout.coverLines({
    kind: 'outbound', profile: PROFILE, groupName: 'g', triggerAt: AT, photoCount: 11, excludedCount: 27,
    leftOutText: '26 documents, 1 screenshot', formCount: 1,
  }));
  assert.ok(lines.includes('Photos: 11 (excluded 27 - not the truck)'));
  assert.ok(lines.includes('Hand-over form: 1 page, at the end'));
  assert.ok(lines.includes('Left out by AI: 26 documents, 1 screenshot'));
  assert.match(layout.photoCaption({ number: 1, total: 1, sentAt: AT, fromName: 'Eddy', form: true }), /^Hand-over form 1 of 1 - Nov 6, 2026/);
});
