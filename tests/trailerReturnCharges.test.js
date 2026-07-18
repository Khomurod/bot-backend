/**
 * Pure return-charge + confirm-gating helpers (admin GuidedReturn).
 *
 * Covers the two release blockers this module was extracted for:
 *   3.2 — Confirm return stays blocked until required return/damage photos exist.
 *   3.3 — Duplicate-type charges are summed, never overwritten and lost.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE = path.resolve(__dirname, '../admin/src/pages/trailer/rentals/returnCharges.js');

let m;
test.before(async () => { m = await import(pathToFileURL(MODULE).href); });

// ── 3.3 duplicate-type charges ──

test('two cleaning charges are summed, not lost', () => {
  const totals = m.sumChargesByType([
    { type: 'cleaning_charge', amount: 100 },
    { type: 'cleaning_charge', amount: 50 },
  ]);
  assert.equal(totals.cleaning_charge, 150);
});

test('damage and cleaning stay separate', () => {
  const totals = m.sumChargesByType([
    { type: 'damage_charge', amount: 200 },
    { type: 'cleaning_charge', amount: 75 },
  ]);
  assert.equal(totals.damage_charge, 200);
  assert.equal(totals.cleaning_charge, 75);
});

test('buildReturnCharges rolls the damage field and a damage row together', () => {
  const payload = m.buildReturnCharges({
    charges: [
      { type: 'damage_charge', amount: 100, description: 'dent' },
      { type: 'cleaning_charge', amount: 40 },
      { type: 'cleaning_charge', amount: 60 },
    ],
    damageCharge: 25,
    hasDamage: true,
    damageDescription: 'cracked light',
  });
  assert.equal(payload.damage_charge, 125); // 25 field + 100 row
  assert.equal(payload.cleaning_charge, 100); // 40 + 60, not 60
  assert.match(payload.description, /cracked light/);
  assert.match(payload.description, /Damage: dent/);
});

test('nextUnusedChargeType prevents duplicate rows and returns null when exhausted', () => {
  assert.equal(m.nextUnusedChargeType([]), 'damage_charge');
  assert.equal(
    m.nextUnusedChargeType([{ type: 'damage_charge' }, { type: 'cleaning_charge' }]),
    'late_fee',
  );
  const all = m.CHARGE_TYPES.map(([t]) => ({ type: t }));
  assert.equal(m.nextUnusedChargeType(all), null);
});

// ── 3.2 return-photo / damage gating ──

test('no stored or selected return photo keeps confirm blocked', () => {
  const missing = m.returnBlockers({ returnPhotoCount: 0 });
  assert.ok(missing.includes('Add at least one return photo'));
});

test('one selected return photo satisfies the photo requirement', () => {
  const missing = m.returnBlockers({ returnPhotoCount: 1 });
  assert.equal(missing.length, 0);
});

test('an already-stored photo satisfies the requirement (no new upload needed)', () => {
  // returnPhotoCount is stored + selected; a stored-only count of 1 is enough.
  const missing = m.returnBlockers({ returnPhotoCount: 1, hasDamage: false });
  assert.equal(missing.length, 0);
});

test('new damage requires its own description and photo, separate from return photos', () => {
  const missing = m.returnBlockers({
    returnPhotoCount: 2, hasDamage: true, damageDescription: '', damagePhotoCount: 0,
  });
  assert.ok(missing.includes('Describe the new damage'));
  assert.ok(missing.includes('Add at least one photo of the new damage'));
});

test('a normal return with a photo and no damage does not require damage evidence', () => {
  const missing = m.returnBlockers({ returnPhotoCount: 1, hasDamage: false });
  assert.equal(missing.length, 0);
});

test('damage fully documented clears the blockers', () => {
  const missing = m.returnBlockers({
    returnPhotoCount: 1, hasDamage: true, damageDescription: 'scrape', damagePhotoCount: 1,
  });
  assert.equal(missing.length, 0);
});
