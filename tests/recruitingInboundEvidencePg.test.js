/**
 * Has a candidate's text EVER reached this application?
 *
 * THE QUIETEST FAILURE THE RECRUITING FEATURE HAS. Every readiness check is a
 * SETTING — after-hours switched on, working hours set, knowledge approved, an
 * AI capability, a provider, a recruiter with a RingCentral login. Not one of
 * them proves an inbound message can still arrive.
 *
 * Inbound SMS depends on a RingCentral webhook subscription created by the
 * Python leads engine, which sheds filters when a tenant refuses one and can
 * lose the subscription outright. After that the feature reads "ready" and
 * answers nobody, forever, and `recruiting_ai_conversations` stays empty for a
 * reason no screen can show.
 *
 * Every inbound message already writes a mirror row, so this needs no new
 * polling and no new table — it reads the telemetry the feature already
 * produces. What a unit test cannot show is that the SQL means what it says
 * against the real accumulated schema.
 *
 * Needs TEST_DATABASE_URL and SKIPS without it. A skipped test is not a
 * passing test (CLAUDE.md); CI fails on any skip.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  return { h, ...h.loadDataLayer(['facebookLeads/smsMirrors']) };
}

const mirror = (m, over = {}) => m.insertFacebookLeadSmsMirror({
  telegramChatId: over.chat ?? -1001,
  telegramMessageId: over.msg ?? 1,
  driverPhone: '+15550100',
  smsBody: 'hello',
  sourceType: over.sourceType ?? 'inbound_rc',
});

test('nothing inbound EVER is a different answer from a quiet week',
  { skip: skipWithoutPg() }, async (t) => {
    const m = await setup(t);
    const store = m['facebookLeads/smsMirrors'] || m.smsMirrors;

    const empty = await store.summariseInboundSms();
    assert.equal(empty.inWindow, 0);
    assert.equal(empty.everAt, null, 'the signal the readiness check acts on');

    await mirror(store, { msg: 1 });
    const seen = await store.summariseInboundSms();
    assert.equal(seen.inWindow, 1);
    assert.ok(seen.everAt, 'one real inbound message changes the answer');
  });

/**
 * OUTBOUND MUST NOT COUNT. Wenze's own replies and the recruiter's messages
 * share this table; counting them would make a dead inbound path look alive,
 * which is the precise failure this exists to catch.
 */
test('only inbound_rc rows count as evidence the path is alive',
  { skip: skipWithoutPg() }, async (t) => {
    const m = await setup(t);
    const store = m['facebookLeads/smsMirrors'] || m.smsMirrors;

    await mirror(store, { msg: 1, sourceType: 'outbound_auto' });
    await mirror(store, { msg: 2, sourceType: 'outbound_ai' });
    await mirror(store, { msg: 3, sourceType: 'outbound_recruiter' });

    const out = await store.summariseInboundSms();
    assert.equal(out.inWindow, 0);
    assert.equal(out.everAt, null,
      'three messages WE sent are not evidence a candidate can reach us');
  });

/** An old conversation is still proof the path once worked. */
test('inbound outside the window still counts as ever', { skip: skipWithoutPg() }, async (t) => {
  const m = await setup(t);
  const store = m['facebookLeads/smsMirrors'] || m.smsMirrors;

  await mirror(store, { msg: 1 });
  await m.h.query(
    "UPDATE facebook_lead_sms_mirrors SET created_at = NOW() - INTERVAL '90 days'"
  );

  const out = await store.summariseInboundSms();
  assert.equal(out.inWindow, 0, 'not this week');
  assert.ok(out.everAt, 'but the subscription has worked at some point');
});
