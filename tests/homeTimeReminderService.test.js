'use strict';

/**
 * What is left of the Home Time reminder service, and what must stay gone.
 *
 * THE REMINDER LOOP WAS REMOVED, and this file is what stops it coming back. It
 * chased a driver for two PLANNED dates — a first reminder after twelve hours, a
 * second twelve hours later, then the request marked unanswered. That work
 * produced a guess about next week, while the dates that actually matter, when
 * the driver reached home and when they left again, are read from the Dispatcher
 * Board by services/homeTime/boardPresenceWatch.js.
 *
 * What stays on this timer is housekeeping with no audience: closing a request
 * whose window has passed so it stops blocking the next one. Nobody is told.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVICE_PATH = path.resolve(__dirname, '../services/homeTimeReminderService.js');
const service = require('../services/homeTimeReminderService');

test('the reminder sweep is gone from the module surface', () => {
  assert.equal(service.runHomeTimeReminderCheck, undefined,
    'a retired path kept "just in case" is a path that comes back');
  assert.equal(typeof service.runHomeTimeCleanupSweep, 'function',
    'closing a passed-window request is housekeeping and stays');
});

test('nothing in the service schedules or sends a reminder any more', () => {
  const source = fs.readFileSync(SERVICE_PATH, 'utf8');
  // Comments explain why the loop went, so look for the machinery itself.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const gone of [
    'listDueHomeTimeReminders',
    'claimHomeTimeReminder',
    'markHomeTimeClarificationUnanswered',
    'buildReminderMessage',
  ]) {
    assert.equal(code.includes(gone), false, `${gone} must not be reachable from the reminder service`);
  }
});

test('a request is never given a next reminder time when it is recorded', () => {
  const flow = fs.readFileSync(
    path.resolve(__dirname, '../services/homeTimeClarificationFlow.js'), 'utf8'
  );
  const record = flow.slice(flow.indexOf('async function recordAndPostRequest'));
  assert.match(record, /nextReminderAt:\s*null/,
    'the one path that creates a request must schedule nothing');
});

// ─── the run ledger still tells the truth about this worker ───

test('Home Time switched off is BLOCKED in the ledger, not a healthy pass', () => {
  const out = service.reminderRunSummary({ enabled: false });
  assert.equal(out.blocked, 'Home Time is switched off in Settings');
  assert.equal(out.closed, undefined, 'a blocked pass reports no work, not zero work');
});

test('a normal tick reports what it closed and carries no error', () => {
  const out = service.reminderRunSummary({ enabled: true, scanned: 12, closed: 2 });
  assert.deepEqual(out, { scanned: 12, closed: 2 });
  assert.equal(out.error, undefined);
});

test('a pass that found nothing to close is still a real pass', () => {
  const out = service.reminderRunSummary({ enabled: true, scanned: 0, closed: 0 });
  assert.deepEqual(out, { scanned: 0, closed: 0 });
  assert.equal(out.blocked, undefined);
});
