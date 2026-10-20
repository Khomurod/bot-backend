'use strict';

/**
 * services/driverGroupDirectoryService.js — the directory read is shared for
 * 30 seconds, and a write to a group or profile clears it at once, so an
 * admin's edit never looks unsaved.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
let reads = 0;
const dbPath = require.resolve(path.join(ROOT, 'database/db.js'));
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { listGroupDirectorySourceRows: async () => { reads += 1; return [{ group_id: 1, group_type: 'driver', group_name: 'WENZE UNIT # 1 SAM DOE' }]; } },
};

const directory = require('../services/driverGroupDirectoryService');
const { forgetGroupRows } = require('../database/groupRowCache');

test('one read for a burst of callers; a write clears it at once', async () => {
  directory.__clearDirectoryCacheForTests();
  reads = 0;
  await Promise.all([
    directory.listCanonicalDriverGroups(),
    directory.listCanonicalDriverGroups(),
    directory.listCanonicalDriverGroups({ operational: true }),
  ]);
  assert.equal(reads, 1, 'concurrent callers share one read');
  await directory.listCanonicalDriverGroups();
  assert.equal(reads, 1, 'within 30 s, no new read');

  forgetGroupRows();
  await directory.listCanonicalDriverGroups();
  assert.equal(reads, 2, 'a write is never hidden behind the cache');

  await directory.listCanonicalDriverGroups({ includeNonDrivers: false });
  assert.equal(reads, 3, 'drivers-only is its own read');
});

test('each caller gets its own copy: changing one result cannot change the next', async () => {
  directory.__clearDirectoryCacheForTests();
  const a = await directory.listCanonicalDriverGroups();
  a[0].group_name = 'changed';
  const b = await directory.listCanonicalDriverGroups();
  assert.notEqual(b[0].group_name, 'changed');
});
