/**
 * Migration 0070 and the queue's new statements against a REAL PostgreSQL.
 *
 * What only a real database proves: the column applies on top of the baseline
 * and re-applies as a no-op, an abandoned event is never claimed again, the
 * Telegram-posted stamp is kept by the first write and survives a Retry, and a
 * Retry restores the attempt budget.
 *
 * Needs TEST_DATABASE_URL and SKIPS without it. A skipped test is not a passing
 * test (CLAUDE.md); CI fails on any skip.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const MIGRATION = fs.readFileSync(
  path.join(__dirname, '..', 'database', 'migrations', '0070_facebook_event_telegram_posted.sql'),
  'utf8',
);

test('migration 0070 applies to the baseline and re-applies as a no-op', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: MIGRATION });
  await harness.query(MIGRATION);
  const res = await harness.query(
    `SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'facebook_webhook_events' AND column_name = 'telegram_posted_at'`
  );
  assert.equal(res.rows.length, 1);
  assert.equal(res.rows[0].is_nullable, 'YES');
});

test('abandon, mark posted and reset behave as the worker relies on', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: allMigrationsSql() });
  const { facebookLeads: fb } = harness.loadDataLayer(['facebookLeads']);

  const [event] = await fb.insertFacebookWebhookEvents([{
    eventKey: 'leadgen:9001:lead-1', pageId: '9001', eventType: 'leadgen', payload: { leadgenId: 'lead-1' },
  }]);

  let claimed = await fb.claimPendingFacebookWebhookEvents(10);
  assert.equal(claimed.length, 1);

  await fb.markFacebookWebhookEventTelegramPosted(event.id);
  const first = (await harness.query(
    'SELECT telegram_posted_at FROM facebook_webhook_events WHERE id = $1', [event.id]
  )).rows[0].telegram_posted_at;
  assert.ok(first, 'stamped');
  await new Promise((resolve) => setTimeout(resolve, 20));
  await fb.markFacebookWebhookEventTelegramPosted(event.id);
  const again = (await harness.query(
    'SELECT telegram_posted_at FROM facebook_webhook_events WHERE id = $1', [event.id]
  )).rows[0].telegram_posted_at;
  assert.equal(again.getTime(), first.getTime(), 'the first stamp is kept');

  assert.ok(await fb.abandonFacebookWebhookEvent(event.id, 'No active Facebook Page connection'));
  await harness.query('UPDATE facebook_webhook_events SET next_retry_at = NOW() - INTERVAL \'1 minute\'');
  claimed = await fb.claimPendingFacebookWebhookEvents(10);
  assert.equal(claimed.length, 0, 'an abandoned event is never claimed');

  const reset = await fb.resetFacebookWebhookEventByIdentifier('leadgen:9001:lead-1');
  assert.equal(reset.status, 'pending');
  assert.equal(reset.attempt_count, 0, 'a Retry restores the budget');
  assert.ok(reset.telegram_posted_at, 'and remembers the lead is already in the group');
});
