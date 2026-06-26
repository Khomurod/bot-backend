const test = require('node:test');
const assert = require('node:assert');
const { normalizeStatus, isoDateOrNull, matchCandidate } = require('../services/homeTimeImportHelpers');

test('normalizeStatus maps spreadsheet labels to road/home/null', () => {
  assert.strictEqual(normalizeStatus('On the Road'), 'road');
  assert.strictEqual(normalizeStatus('road'), 'road');
  assert.strictEqual(normalizeStatus('At Home'), 'home');
  assert.strictEqual(normalizeStatus('home'), 'home');
  assert.strictEqual(normalizeStatus('whatever'), null);
  assert.strictEqual(normalizeStatus(''), null);
});

test('isoDateOrNull accepts only valid YYYY-MM-DD', () => {
  assert.strictEqual(isoDateOrNull('2026-05-26'), '2026-05-26');
  assert.strictEqual(isoDateOrNull('5/26/2026'), null);
  assert.strictEqual(isoDateOrNull('2026-13-40'), null);
  assert.strictEqual(isoDateOrNull(''), null);
  assert.strictEqual(isoDateOrNull(null), null);
});

test('matchCandidate matches by profile name, then group title, else null', () => {
  const candidates = [
    { group_id: 1, full_name: 'Anthony Collins', group_name: 'WENZE UNIT # 12 ANTHONY COLLINS' },
    { group_id: 2, full_name: '', group_name: 'WENZE UNIT # 2614 TERRELL DALTON (COMPANY DRIVER)' },
    { group_id: 3, full_name: 'Omar Alawad', group_name: 'WENZE UNIT # 99 OMAR ALAWAD' },
  ];
  assert.strictEqual(matchCandidate('ANTHONY COLLINS', candidates)?.group_id, 1);
  // No profile name on #2, so it must match via the group title.
  assert.strictEqual(matchCandidate('Terrell Dalton', candidates)?.group_id, 2);
  assert.strictEqual(matchCandidate('Someone Unknown', candidates), null);
  assert.strictEqual(matchCandidate('', candidates), null);
});
