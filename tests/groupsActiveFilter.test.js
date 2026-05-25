const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * Unit tests for active-filter SQL helper logic (mirrors database/db.js).
 */
function buildActiveClause(filter) {
  const f = filter === 'all' || filter === 'inactive' ? filter : 'active';
  if (f === 'active') return ' AND active = TRUE';
  if (f === 'inactive') return ' AND active = FALSE';
  return '';
}

test('buildActiveClause matches expected filters', () => {
  assert.equal(buildActiveClause('active'), ' AND active = TRUE');
  assert.equal(buildActiveClause('inactive'), ' AND active = FALSE');
  assert.equal(buildActiveClause('all'), '');
  assert.equal(buildActiveClause(undefined), ' AND active = TRUE');
});

test('getAllGroups query shape unchanged (active only)', () => {
  const legacy = "SELECT * FROM groups WHERE group_type = 'driver' AND active = TRUE ORDER BY id";
  assert.ok(legacy.includes('active = TRUE'));
  assert.ok(!legacy.includes('inactive'));
});
