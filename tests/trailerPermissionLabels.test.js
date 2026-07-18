/**
 * Plain-language permission labels (§7). Every seeded permission key must have
 * a hand-written, understandable label — a raw underscore key must never be the
 * primary label — and unknown keys fall back to a humanized form.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const MODULE = path.resolve(__dirname, '../admin/src/pages/trailer/a11y/permissionLabels.js');
let m;
test.before(async () => { m = await import(pathToFileURL(MODULE).href); });

/** Every permission key seeded by schema.sql. */
function seededKeys() {
  const schema = fs.readFileSync(path.resolve(__dirname, '../database/schema.sql'), 'utf8');
  const keys = new Set();
  for (const match of schema.matchAll(/INSERT INTO permissions[^;]+;/gs)) {
    for (const row of match[0].matchAll(/\('([a-z0-9_.]+)'/g)) keys.add(row[1]);
  }
  return [...keys];
}

test('the required example maps to the required label', () => {
  assert.equal(
    m.permissionLabel('trailer_payments.record_overpayment'),
    'Record extra payments as company credit',
  );
});

test('every seeded permission key has a hand-written label (no raw fallback)', () => {
  const keys = seededKeys();
  assert.ok(keys.length >= 25, `expected the full catalog, got ${keys.length}`);
  for (const key of keys) {
    assert.ok(m.PERMISSION_LABELS[key], `missing plain-language label for ${key}`);
    // The label is a sentence, not the key.
    assert.notEqual(m.PERMISSION_LABELS[key], key);
    assert.ok(!/[a-z]_[a-z]+\./.test(m.PERMISSION_LABELS[key]), `label for ${key} looks like a raw key`);
  }
});

test('unknown keys are humanized, never returned raw', () => {
  assert.equal(m.permissionLabel('future_area.do_thing'), 'Future area: do thing');
  assert.equal(m.permissionLabel('single'), 'single');
  // A backend-provided description wins over humanization.
  assert.equal(m.permissionLabel('x.y', 'Provided description'), 'Provided description');
});

test('grouping puts related permissions together and labels every item', () => {
  const groups = m.groupPermissions(seededKeys().map((k) => ({ permission_key: k })));
  const names = groups.map((g) => g.group);
  assert.ok(names.includes('Money'));
  assert.ok(names.includes('Rentals'));
  assert.ok(names.includes('Trailers'));
  for (const g of groups) {
    for (const item of g.items) {
      assert.ok(item.label && item.label !== item.key, `${item.key} has no plain label`);
    }
  }
});
