'use strict';

/**
 * services/truckPhotos/sweep.js — the hourly pass. A claim a stopped process
 * left pending is closed and its recipient told, in fixed words; while the
 * feature is switched off the pass reports `blocked` (switched off, not
 * broken); the pass is recorded under `truck_photo_reports`, which the
 * background-service catalogue knows; and it rides the scheduler's retention
 * tick rather than a timer of its own.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { sweepTruckPhotoReports, STALE_MINUTES } = require('../services/truckPhotos/sweep');
const { getServiceEntry } = require('../lib/operations/backgroundServiceCatalog');
const { statusFromSummary } = require('../services/operations/runLedger');

function harness({ enabled = true, stale = [], active = [] } = {}) {
  const told = [];
  const asked = [];
  return {
    told,
    asked,
    deps: {
      getSettings: async () => ({ enabled, recipientTelegramId: '777000' }),
      failStaleReports: async (minutes, reason, exceptIds) => { asked.push({ minutes, reason, exceptIds }); return stale; },
      activeReportIds: () => active,
      tellRecipient: async (args) => { told.push(args); return true; },
      telegram: () => ({ fake: true }),
    },
  };
}

test('a claim left pending by a restart is closed, and the recipient is told why', async () => {
  const stale = [{
    id: 4, kind: 'inbound', groupName: 'Jerome Joyner 1', triggeredByName: 'Kim Rowe',
    createdAt: new Date('2026-11-06T16:00:00Z'),
  }];
  const h = harness({ stale, active: [9, 12] });
  const out = await sweepTruckPhotoReports(h.deps);
  assert.deepEqual(out, { closed: 1, told: 1 });
  assert.equal(h.asked[0].minutes, STALE_MINUTES);
  assert.deepEqual(h.asked[0].exceptIds, [9, 12], 'a report still queued here is not "left behind"');
  assert.match(h.asked[0].reason, /restart/);
  assert.equal(h.told[0].recipient, '777000');
  assert.match(h.told[0].text, /INBOUND in "Jerome Joyner 1", marked by Kim Rowe/);
  assert.match(h.told[0].text, /If no PDF arrived for it, write "inbound" in the group again/);
});

test('switched off: blocked, not failed — and a leftover claim is still closed', async () => {
  const h = harness({ enabled: false, stale: [{ id: 1, kind: 'outbound', createdAt: new Date() }] });
  const out = await sweepTruckPhotoReports(h.deps);
  assert.match(out.blocked, /switched off/);
  assert.equal(out.closed, 1);
  assert.equal(statusFromSummary(out).status, 'blocked');
});

test('nothing to close is a clean pass', async () => {
  const h = harness();
  assert.deepEqual(await sweepTruckPhotoReports(h.deps), { closed: 0, told: 0 });
  assert.equal(h.told.length, 0);
});

test('the pass is catalogued, recorded, and rides the scheduler\'s hourly retention tick', () => {
  const entry = getServiceEntry('truck_photo_reports');
  assert.ok(entry, 'in the background-service catalogue');
  assert.equal(entry.configurable, true, 'switched off reads blocked, never failed');
  assert.equal(entry.critical, false);
  assert.equal(entry.expectedIntervalSeconds, 3600);
  const root = path.join(__dirname, '..');
  const sweep = fs.readFileSync(path.join(root, 'services/truckPhotos/sweep.js'), 'utf8');
  const pipeline = fs.readFileSync(path.join(root, 'services/truckPhotos/pipeline.js'), 'utf8');
  assert.match(sweep, /withRunRecord\('truck_photo_reports'/);
  assert.match(pipeline, /withRunRecord\('truck_photo_reports'/);
  const scheduler = fs.readFileSync(path.join(root, 'services/schedulerService.js'), 'utf8');
  assert.match(scheduler, /truckPhotos\/sweep'\)\.runTruckPhotoSweep\(\)/);
});
