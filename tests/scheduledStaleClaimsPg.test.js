'use strict';

/**
 * Releasing a stuck scheduled message, against a real PostgreSQL.
 *
 * `scheduled_at` is a TIMESTAMP without a zone, so the age is computed in SQL;
 * a fake pool would happily "pass" an interval expression production rejects.
 * And the release must be guarded on `processing`, so a send that finished
 * after all is never overwritten.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPgHarness, skipWithoutPg } = require('./helpers/pgHarness');

async function insert(h, { status, scheduledAgo, type = 'weekly' }) {
  const res = await h.query(
    `INSERT INTO scheduled_messages
       (message_text_en, status, scheduled_at, schedule_type, schedule_timezone,
        weekly_day_of_week, weekly_time_local)
     VALUES ('PTI reminder', $1, NOW() - ($2 || '')::interval, $3, 'America/Chicago', 1, '09:00')
     RETURNING id`,
    [status, scheduledAgo, type]
  );
  return res.rows[0].id;
}

test('only claims long past their time are stale, with their age in days',
  { skip: skipWithoutPg() }, async (t) => {
    const h = await createPgHarness(t);
    const { scheduledMessages: store } = h.loadDataLayer(['scheduledMessages']);
    const old = await insert(h, { status: 'processing', scheduledAgo: '168 days' });
    const live = await insert(h, { status: 'processing', scheduledAgo: '10 minutes' });
    await insert(h, { status: 'pending', scheduledAgo: '3 days' });

    const stale = await store.listStaleClaims({ olderThanMinutes: 120 });
    assert.deepEqual(stale.map((r) => r.id), [old], 'a send ten minutes old may still be running');
    assert.ok(stale[0].days_overdue > 167 && stale[0].days_overdue < 169);
    assert.ok(!stale.some((r) => r.id === live));
  });

test('release reschedules or fails, and never overwrites a send that finished',
  { skip: skipWithoutPg() }, async (t) => {
    const h = await createPgHarness(t);
    const { scheduledMessages: store } = h.loadDataLayer(['scheduledMessages']);
    const a = await insert(h, { status: 'processing', scheduledAgo: '1 day' });
    const b = await insert(h, { status: 'processing', scheduledAgo: '90 days' });
    const done = await insert(h, { status: 'sent', scheduledAgo: '1 day', type: 'one_time' });

    assert.equal(await store.releaseStaleClaim(a, { nextScheduledAt: '2026-10-26T14:00:00.000Z' }), true);
    assert.equal(await store.releaseStaleClaim(b), true);
    assert.equal(await store.releaseStaleClaim(done), false, 'a finished send is not touched');

    const rows = (await h.query(
      'SELECT id, status, last_run_status FROM scheduled_messages WHERE id = ANY($1) ORDER BY id', [[a, b, done]]
    )).rows;
    assert.deepEqual(rows, [
      { id: a, status: 'pending', last_run_status: 'interrupted' },
      { id: b, status: 'failed', last_run_status: 'interrupted' },
      { id: done, status: 'sent', last_run_status: null },
    ]);
  });
