/**
 * Standing a reminder down re-checks its REASON at update time.
 *
 * The reminder service reads its due rows, then clears the schedule for the ones
 * whose group is inactive. An administrator can reactivate a group in between —
 * and nothing reschedules a reminder on reactivation, so clearing it on a stale
 * read means the newly-active group misses that reminder permanently, silently,
 * and with no way to notice.
 *
 * The guard is a join in the UPDATE, so it has to be proven where it lives.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();

async function seed(harness, { groupActive }) {
  await harness.query(
    `INSERT INTO groups (id, telegram_group_id, group_name, group_type, active)
     VALUES (1, '-100', 'WENZE UNIT # 5 PAT D', 'driver', $1)`,
    [groupActive]
  );
  const res = await harness.query(
    `INSERT INTO home_time_requests
       (group_id, telegram_group_id, status, source, next_reminder_at)
     VALUES (1, '-100', 'awaiting_return_to_road', 'telegram', NOW() + INTERVAL '1 hour')
     RETURNING id`
  );
  return res.rows[0].id;
}

test('an inactive group stands down', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { homeTimeClarification } = harness.loadDataLayer(['homeTimeClarification']);
  const id = await seed(harness, { groupActive: false });

  const row = await homeTimeClarification.cancelHomeTimeReminderSchedule(id, {
    onlyIfGroupInactive: true,
  });
  assert.ok(row, 'the stand-down happened');
  assert.equal(row.next_reminder_at, null);
});

test('a group reactivated in the meantime KEEPS its reminder', { skip: skipWithoutPg() }, async (t) => {
  // The race: the service read `group_active = false`, an admin reactivated the
  // group, and this write arrives afterwards. Without the guard it clears
  // anyway, and nothing ever schedules that reminder again.
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { homeTimeClarification } = harness.loadDataLayer(['homeTimeClarification']);
  const id = await seed(harness, { groupActive: true });

  const row = await homeTimeClarification.cancelHomeTimeReminderSchedule(id, {
    onlyIfGroupInactive: true,
  });
  assert.equal(row, null, 'the reason no longer holds, so nothing is cleared');

  const after = await harness.query('SELECT next_reminder_at FROM home_time_requests WHERE id = $1', [id]);
  assert.ok(after.rows[0].next_reminder_at, 'and the reminder survives');
});

test('the unguarded stand-down is unchanged — its reason is different', { skip: skipWithoutPg() }, async (t) => {
  // Driver messaging being OFF has nothing to do with the group's own state, so
  // re-checking it there would refuse a stand-down that is entirely correct.
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { homeTimeClarification } = harness.loadDataLayer(['homeTimeClarification']);
  const id = await seed(harness, { groupActive: true });

  const row = await homeTimeClarification.cancelHomeTimeReminderSchedule(id);
  assert.ok(row, 'an active group is stood down when the reason is messaging, not the group');
  assert.equal(row.next_reminder_at, null);
});

test('a schedule already clear matches nothing, either way', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { homeTimeClarification } = harness.loadDataLayer(['homeTimeClarification']);
  const id = await seed(harness, { groupActive: false });

  assert.ok(await homeTimeClarification.cancelHomeTimeReminderSchedule(id, { onlyIfGroupInactive: true }));
  assert.equal(
    await homeTimeClarification.cancelHomeTimeReminderSchedule(id, { onlyIfGroupInactive: true }),
    null,
    'idempotent, so a retry does not inflate the stand-down count'
  );
});
