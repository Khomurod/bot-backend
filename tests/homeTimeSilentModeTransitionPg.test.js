/**
 * Silent-mode transition + internal-alert outbox — real PostgreSQL.
 *
 * Two things the mocked suites cannot prove:
 *
 *  1. Turning driver messaging off clears EVERY scheduled reminder immediately,
 *     including ones not yet due. The reminder sweep only ever sees reminders
 *     that are already due, so a reminder scheduled six hours out survived the
 *     switch and fired the moment messaging was turned back on.
 *
 *  2. The alert outbox's atomicity is real: leases, crash recovery and
 *     concurrent claims depend on actual Postgres semantics
 *     (FOR UPDATE SKIP LOCKED, timestamp comparisons), not on a JS fake.
 *
 * Requires TEST_DATABASE_URL (see CLAUDE.md → PostgreSQL integration tests).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { Pool } = require('pg');

const { skipWithoutPg } = require('./helpers/trailerPgHarness');
const { purgeDataLayer } = require('./helpers/purgeDataLayer');

const REPO = path.resolve(__dirname, '..');
const POOL_PATH = require.resolve('../database/pool');

async function createHarness(t) {
  const dbName = `htsilent_${crypto.randomBytes(6).toString('hex')}`;
  const adminUrl = process.env.TEST_DATABASE_URL;
  const dbUrl = new URL(adminUrl);
  dbUrl.pathname = `/${dbName}`;

  const quiet = (p) => { p.on('error', () => {}); return p; };
  const admin = quiet(new Pool({ connectionString: adminUrl, max: 2 }));
  await admin.query(`CREATE DATABASE ${dbName} WITH ENCODING 'UTF8' TEMPLATE template0`);
  const pool = quiet(new Pool({ connectionString: dbUrl.toString(), max: 6 }));

  await pool.query(fs.readFileSync(path.join(REPO, 'database/schema.sql'), 'utf8'));
  const { runMigrations } = require('../database/migrate');
  await runMigrations(pool, { silent: true });

  const prior = require.cache[POOL_PATH];
  require.cache[POOL_PATH] = {
    id: POOL_PATH,
    filename: POOL_PATH,
    loaded: true,
    exports: {
      pool,
      query: (text, values) => pool.query(text, values),
      ping: async () => true,
    },
  };
  // The data layer is purged by WALKING database/ rather than from a list, which
  // goes stale the moment a module there is split into a package.
  const reload = purgeDataLayer([
    '../services/homeTimeSilentModeTransition', '../services/homeTimeInternalAlert',
    '../services/homeTimeReminderService',
  ].map((spec) => require.resolve(spec)));

  t.after(async () => {
    for (const p of reload) delete require.cache[p];
    if (prior) require.cache[POOL_PATH] = prior; else delete require.cache[POOL_PATH];
    await pool.end().catch(() => {});
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  });

  const outbox = require('../database/homeTimeInternalAlertOutbox');
  const transition = require('../services/homeTimeSilentModeTransition');
  const ht = require('../database/homeTime');

  async function seedGroup() {
    const g = await pool.query(
      `INSERT INTO groups (telegram_group_id, group_name, group_type)
       VALUES ($1, 'WENZE UNIT # 96266', 'driver') RETURNING id`,
      [-1000000 - Math.floor(Math.random() * 1000000)],
    );
    return g.rows[0].id;
  }

  /** A clarification awaiting its return date, with a reminder N hours out. */
  async function seedClarification({ groupId, reminderInHours = null, channel = 'driver', status = 'awaiting_return_to_road' } = {}) {
    const r = await pool.query(
      `INSERT INTO home_time_requests
         (group_id, driver_name, unit_number, status, home_from, next_reminder_at, clarification_channel)
       VALUES ($1, 'Pascal F', '96266', $2, '2099-08-02',
               CASE WHEN $3::numeric IS NULL THEN NULL ELSE NOW() + ($3 || ' hours')::interval END,
               $4)
       RETURNING *`,
      [groupId, status, reminderInHours, channel],
    );
    return r.rows[0];
  }

  async function row(id) {
    const r = await pool.query('SELECT * FROM home_time_requests WHERE id = $1', [id]);
    return r.rows[0];
  }

  return {
    pool, outbox, transition, ht, seedGroup, seedClarification, row,
  };
}

const opts = { skip: skipWithoutPg() };

// ── 1-5: the exact scenario from the audit ──

test('a reminder six hours out is cleared the instant silent mode is turned on, and never replays', opts, async (t) => {
  const h = await createHarness(t);
  const groupId = await h.seedGroup();

  // 1. A reminder scheduled SIX HOURS in the future (not due — the sweep would
  //    never see it).
  const req = await h.seedClarification({ groupId, reminderInHours: 6 });
  assert.ok(req.next_reminder_at, 'precondition: a future reminder is scheduled');

  // 2. Silent mode is turned off (driver messaging disabled) right now.
  const result = await h.transition.applySilentModeTransition();

  // 3. The schedule is cleared immediately.
  assert.equal(result.remindersCleared, 1);
  const after = await h.row(req.id);
  assert.equal(after.next_reminder_at, null, 'the future reminder is stood down');
  assert.equal(Number(after.reminder_count), 0, 'the allowance is NOT consumed');
  assert.equal(after.status, 'awaiting_return_to_road', 'the request stays open');
  assert.equal(after.clarification_channel, 'internal', 'handling moved to staff');

  // 4 & 5. Turning it back on must not resurrect anything: the reminder sweep
  //        only reads rows with a non-null, due next_reminder_at.
  await h.ht.updateHomeTimeSettings({ driver_clarification_enabled: true });
  const due = await h.ht.listDueHomeTimeReminders(new Date(Date.now() + 24 * 3600 * 1000).toISOString());
  assert.equal(due.filter((d) => d.id === req.id).length, 0,
    'even a day later the stood-down reminder is not due — nothing replays');
});

test('the stand-down covers every open clarification, not just due ones', opts, async (t) => {
  const h = await createHarness(t);
  const groupId = await h.seedGroup();
  const future = await h.seedClarification({ groupId, reminderInHours: 6 });
  const alsoFuture = await h.seedClarification({ groupId, reminderInHours: 48 });
  const overdue = await h.seedClarification({ groupId, reminderInHours: -1 });

  const result = await h.transition.applySilentModeTransition();
  assert.equal(result.remindersCleared, 3);
  for (const r of [future, alsoFuture, overdue]) {
    // eslint-disable-next-line no-await-in-loop
    assert.equal((await h.row(r.id)).next_reminder_at, null, `request ${r.id}`);
  }
});

test('the stand-down does not touch resolved requests or unrelated data', opts, async (t) => {
  const h = await createHarness(t);
  const groupId = await h.seedGroup();
  const open = await h.seedClarification({ groupId, reminderInHours: 6 });
  const decided = await h.seedClarification({ groupId, reminderInHours: 6, status: 'approved' });

  await h.transition.applySilentModeTransition();

  assert.equal((await h.row(open.id)).next_reminder_at, null);
  assert.ok((await h.row(decided.id)).next_reminder_at,
    'an approved request is not an open clarification and is left alone');
  assert.equal((await h.row(decided.id)).clarification_channel, 'driver',
    'and its channel is not rewritten');
});

test('the transition queues a staff alert for each switched clarification', opts, async (t) => {
  const h = await createHarness(t);
  const groupId = await h.seedGroup();
  const a = await h.seedClarification({ groupId, reminderInHours: 6 });
  const b = await h.seedClarification({ groupId, reminderInHours: 2 });

  const result = await h.transition.applySilentModeTransition();
  assert.equal(result.switched, 2);
  assert.equal(result.enqueued, 2);
  for (const r of [a, b]) {
    // eslint-disable-next-line no-await-in-loop
    const st = await h.outbox.getInternalAlertRow(r.id);
    assert.equal(st.internal_alert_state, 'pending');
  }
});

test('a clarification already alerted is not queued again', opts, async (t) => {
  const h = await createHarness(t);
  const groupId = await h.seedGroup();
  const already = await h.seedClarification({ groupId, reminderInHours: 6, channel: 'internal' });
  await h.outbox.enqueueInternalAlert(already.id);
  await h.outbox.markInternalAlertDelivered(already.id);

  const result = await h.transition.applySilentModeTransition();
  assert.equal(result.enqueued, 0, 'a delivered alert must never be re-queued');
  assert.equal((await h.outbox.getInternalAlertRow(already.id)).internal_alert_state, 'delivered');
});

test('re-running the transition is safe (idempotent)', opts, async (t) => {
  const h = await createHarness(t);
  const groupId = await h.seedGroup();
  const req = await h.seedClarification({ groupId, reminderInHours: 6 });

  await h.transition.applySilentModeTransition();
  const second = await h.transition.applySilentModeTransition();
  assert.equal(second.remindersCleared, 0, 'nothing left to clear');
  assert.equal(second.switched, 0, 'already on the staff channel');
  assert.equal((await h.row(req.id)).status, 'awaiting_return_to_road');
});

// ── isSilencingTransition gating ──

test('only a genuine true → false flip triggers the transition', opts, async (t) => {
  const h = await createHarness(t);
  const { isSilencingTransition } = h.transition;
  assert.equal(isSilencingTransition({ driver_clarification_enabled: true }, { driver_clarification_enabled: false }), true);
  assert.equal(isSilencingTransition(null, { driver_clarification_enabled: false }), true, 'unset means on');
  assert.equal(isSilencingTransition({ driver_clarification_enabled: false }, { driver_clarification_enabled: false }), false,
    're-saving false must not re-alert');
  assert.equal(isSilencingTransition({ driver_clarification_enabled: true }, { driver_clarification_enabled: true }), false);
  assert.equal(isSilencingTransition({ driver_clarification_enabled: true }, { home_allowance_days: 5 }), false,
    'an unrelated save is not a transition');
});

// ── outbox atomicity ──

test('OUTBOX: a claim leases the row and a second claim is refused', opts, async (t) => {
  const h = await createHarness(t);
  const groupId = await h.seedGroup();
  const req = await h.seedClarification({ groupId, channel: 'internal' });
  await h.outbox.enqueueInternalAlert(req.id);

  const first = await h.outbox.claimInternalAlertById(req.id);
  const second = await h.outbox.claimInternalAlertById(req.id);
  assert.ok(first, 'first caller wins');
  assert.equal(second, null, 'second caller is refused while the lease holds');
  assert.equal(Number(first.internal_alert_attempts), 1);
});

test('OUTBOX: two concurrent workers claim disjoint sets', opts, async (t) => {
  const h = await createHarness(t);
  const groupId = await h.seedGroup();
  const ids = [];
  for (let i = 0; i < 6; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const r = await h.seedClarification({ groupId, channel: 'internal' });
    // eslint-disable-next-line no-await-in-loop
    await h.outbox.enqueueInternalAlert(r.id);
    ids.push(r.id);
  }

  const [a, b] = await Promise.all([
    h.outbox.claimDueInternalAlerts({ limit: 6 }),
    h.outbox.claimDueInternalAlerts({ limit: 6 }),
  ]);
  const claimedA = a.map((r) => r.id);
  const claimedB = b.map((r) => r.id);
  const overlap = claimedA.filter((id) => claimedB.includes(id));
  assert.deepEqual(overlap, [], 'no alert may be claimed by both workers');
  assert.equal(new Set([...claimedA, ...claimedB]).size, claimedA.length + claimedB.length);
});

test('OUTBOX: an expired lease (process crash) becomes claimable again', opts, async (t) => {
  const h = await createHarness(t);
  const groupId = await h.seedGroup();
  const req = await h.seedClarification({ groupId, channel: 'internal' });
  await h.outbox.enqueueInternalAlert(req.id);

  // Claim with a lease that has already expired — exactly the state a worker
  // that died mid-send leaves behind.
  const claimed = await h.outbox.claimInternalAlertById(req.id, { leaseSeconds: -60 });
  assert.ok(claimed, 'claimed');
  assert.equal((await h.outbox.getInternalAlertRow(req.id)).internal_alert_state, 'pending',
    'still pending — the crash never marked it delivered');

  const recovered = await h.outbox.claimDueInternalAlerts({ limit: 5 });
  assert.deepEqual(recovered.map((r) => r.id), [req.id], 'the stale claim is recoverable');
  assert.equal(Number(recovered[0].internal_alert_attempts), 2, 'attempts still bounded');
});

test('OUTBOX: a delivered alert is never claimed again', opts, async (t) => {
  const h = await createHarness(t);
  const groupId = await h.seedGroup();
  const req = await h.seedClarification({ groupId, channel: 'internal' });
  await h.outbox.enqueueInternalAlert(req.id);
  await h.outbox.claimInternalAlertById(req.id);
  await h.outbox.markInternalAlertDelivered(req.id);

  assert.equal(await h.outbox.claimInternalAlertById(req.id), null);
  assert.deepEqual(await h.outbox.claimDueInternalAlerts({ limit: 5 }), []);
  // Re-enqueueing a delivered alert must also be a no-op.
  await h.outbox.enqueueInternalAlert(req.id);
  assert.equal((await h.outbox.getInternalAlertRow(req.id)).internal_alert_state, 'delivered');
});

test('OUTBOX: a failure schedules a backoff retry and is not due immediately', opts, async (t) => {
  const h = await createHarness(t);
  const groupId = await h.seedGroup();
  const req = await h.seedClarification({ groupId, channel: 'internal' });
  await h.outbox.enqueueInternalAlert(req.id);
  await h.outbox.claimInternalAlertById(req.id);
  await h.outbox.markInternalAlertFailed(req.id, { error: 'telegram down' });

  const st = await h.outbox.getInternalAlertRow(req.id);
  assert.equal(st.internal_alert_state, 'pending', 'still retryable');
  assert.match(st.internal_alert_last_error, /telegram down/);
  assert.ok(st.internal_alert_next_attempt_at > new Date(), 'backed off into the future');
  assert.deepEqual(await h.outbox.claimDueInternalAlerts({ limit: 5 }), [],
    'not claimable until the backoff elapses');

  // Once the backoff has passed it is claimable again.
  const later = new Date(Date.now() + 3600 * 1000).toISOString();
  const due = await h.outbox.claimDueInternalAlerts({ nowIso: later, limit: 5 });
  assert.deepEqual(due.map((r) => r.id), [req.id]);
});

test('OUTBOX: retries are bounded — it eventually gives up', opts, async (t) => {
  const h = await createHarness(t);
  const groupId = await h.seedGroup();
  const req = await h.seedClarification({ groupId, channel: 'internal' });
  await h.outbox.enqueueInternalAlert(req.id);

  for (let i = 0; i < h.outbox.MAX_ATTEMPTS + 2; i += 1) {
    // Fast-forward past the backoff WITHOUT disturbing a row that has already
    // given up — only a still-pending alert gets its clock wound forward.
    // eslint-disable-next-line no-await-in-loop
    await h.pool.query(
      `UPDATE home_time_requests
          SET internal_alert_claimed_until = NULL, internal_alert_next_attempt_at = NOW()
        WHERE id = $1 AND internal_alert_state = 'pending'`,
      [req.id],
    );
    // eslint-disable-next-line no-await-in-loop
    const claimed = await h.outbox.claimInternalAlertById(req.id);
    if (!claimed) break;
    // eslint-disable-next-line no-await-in-loop
    await h.outbox.markInternalAlertFailed(req.id, { error: 'still down' });
  }
  const st = await h.outbox.getInternalAlertRow(req.id);
  assert.equal(st.internal_alert_state, 'failed', 'bounded, does not retry forever');
  assert.equal(st.internal_alert_next_attempt_at, null);
  assert.deepEqual(await h.outbox.claimDueInternalAlerts({ limit: 5 }), []);
});

test('OUTBOX: releasing an unsent claim keeps it pending without burning an attempt', opts, async (t) => {
  const h = await createHarness(t);
  const groupId = await h.seedGroup();
  const req = await h.seedClarification({ groupId, channel: 'internal' });
  await h.outbox.enqueueInternalAlert(req.id);
  await h.outbox.claimInternalAlertById(req.id);

  await h.outbox.releaseInternalAlertClaim(req.id);
  const st = await h.outbox.getInternalAlertRow(req.id);
  assert.equal(st.internal_alert_state, 'pending');
  assert.equal(Number(st.internal_alert_attempts), 0, 'the attempt is given back');
  assert.equal(st.internal_alert_claimed_until, null);
});
