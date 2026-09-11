/**
 * The after-hours recruiting tables against a real PostgreSQL.
 *
 * Three claims that are about SQL rather than about JavaScript, and so cannot
 * be proved with a fake:
 *
 *   THE REPLY CAP IS COUNTED IN THE DATABASE. A candidate answering in three
 *   fragments produces three near-simultaneous inbound messages, and a cap
 *   enforced by read-modify-write in JavaScript is walked straight past by the
 *   second one.
 *
 *   ONE CONVERSATION PER NUMBER. `driver_phone UNIQUE` plus an upsert that
 *   fills blanks without overwriting what is already there — the recruiter who
 *   started a conversation keeps it.
 *
 *   A CANDIDATE'S THREAD IS READABLE BY PHONE, which nothing could do before
 *   migration 0035 added the index and the query.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();
const PHONE = '+15551230000';

async function seed(t) {
  return createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
}

const loadConvos = (h) => h.loadDataLayer(['recruitingConversations']);
const loadHours = (h) => h.loadDataLayer(['recruitingHours']);
const loadMirrors = (h) => h.loadDataLayer(['facebookLeads/smsMirrors']);

test('the settings row exists after the migration, with the feature OFF', async (t) => {
  if (await skipWithoutPg(t)) return;
  const h = await seed(t);
  const { recruitingHours } = loadHours(h);
  const settings = await recruitingHours.getRecruitingHours();
  assert.equal(settings.aiAfterHoursEnabled, false, 'a migration must never switch a feature on');
  assert.deepEqual(settings.windows, [], 'and with no hours, the office reads as always open');
  assert.equal(settings.quietStartLocal, '21:00', 'TIME comes back trimmed to HH:MM');
});

test('a reply cap above the schema ceiling is refused by the database', async (t) => {
  if (await skipWithoutPg(t)) return;
  const h = await seed(t);
  await assert.rejects(
    () => h.query('UPDATE recruiting_hours_settings SET max_replies_per_conversation = 99 WHERE id = 1'),
    /max_replies_per_conversation/,
  );
});

test('windows survive a round trip as JSON', async (t) => {
  if (await skipWithoutPg(t)) return;
  const h = await seed(t);
  const { recruitingHours } = loadHours(h);
  const windows = [{ label: 'Weekdays', days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00' }];
  const saved = await recruitingHours.updateRecruitingHours({ windows, aiAfterHoursEnabled: true });
  assert.deepEqual(saved.windows, windows);
  recruitingHours.invalidateCache();
  assert.deepEqual((await recruitingHours.getRecruitingHours()).windows, windows);
});

test('there is one conversation per number, and the first recruiter keeps it', async (t) => {
  if (await skipWithoutPg(t)) return;
  const h = await seed(t);
  const { recruitingConversations: convos } = loadConvos(h);

  const first = await convos.ensureConversation({
    driverPhone: PHONE, leadName: 'Sam Rivera', recruiterId: 7, telegramChatId: -100123,
  });
  const second = await convos.ensureConversation({
    driverPhone: PHONE, leadName: 'Somebody Else', recruiterId: 99, telegramChatId: -100999,
  });

  assert.equal(first.id, second.id, 'the same conversation');
  assert.equal(second.recruiterId, 7, 'a later sighting does not move the conversation');
  assert.equal(second.leadName, 'Sam Rivera');
  const { rows } = await h.query('SELECT COUNT(*)::int AS n FROM recruiting_ai_conversations');
  assert.equal(rows[0].n, 1);
});

test('a blank left by the first sighting is filled by a later one', async (t) => {
  if (await skipWithoutPg(t)) return;
  const h = await seed(t);
  const { recruitingConversations: convos } = loadConvos(h);
  await convos.ensureConversation({ driverPhone: PHONE });
  const later = await convos.ensureConversation({ driverPhone: PHONE, recruiterId: 7, leadName: 'Sam' });
  assert.equal(later.recruiterId, 7);
  assert.equal(later.leadName, 'Sam');
});

test('replies are counted in SQL, so simultaneous messages cannot outrun the cap', async (t) => {
  if (await skipWithoutPg(t)) return;
  const h = await seed(t);
  const { recruitingConversations: convos } = loadConvos(h);
  await convos.ensureConversation({ driverPhone: PHONE });

  // Three at once, as a candidate answering in fragments produces.
  const results = await Promise.all([
    convos.recordReply(PHONE), convos.recordReply(PHONE), convos.recordReply(PHONE),
  ]);
  assert.deepEqual(results.map((r) => r.repliesSent).sort(), [1, 2, 3], 'no increment is lost');
  assert.equal((await convos.getConversation(PHONE)).repliesSent, 3);
});

test('refusals are counted apart from replies — they mean opposite things', async (t) => {
  if (await skipWithoutPg(t)) return;
  const h = await seed(t);
  const { recruitingConversations: convos } = loadConvos(h);
  await convos.ensureConversation({ driverPhone: PHONE });
  await convos.recordRefusal(PHONE, 'unapproved_figure — used 92');
  const row = await convos.recordRefusal(PHONE, 'commitment — guarantees something');
  assert.equal(row.refusals, 2);
  assert.equal(row.repliesSent, 0);
  assert.match(row.lastRefusalReason, /guarantees/);
});

test('the acknowledgement stamp is set once and never moved', async (t) => {
  if (await skipWithoutPg(t)) return;
  const h = await seed(t);
  const { recruitingConversations: convos } = loadConvos(h);
  await convos.ensureConversation({ driverPhone: PHONE });
  const first = await convos.markAcknowledged(PHONE);
  const second = await convos.markAcknowledged(PHONE);
  assert.deepEqual(first.acknowledgedAt, second.acknowledgedAt, 'COALESCE keeps the first stamp');
});

test('standing down keeps the counters — the history is the point', async (t) => {
  if (await skipWithoutPg(t)) return;
  const h = await seed(t);
  const { recruitingConversations: convos } = loadConvos(h);
  await convos.ensureConversation({ driverPhone: PHONE });
  await convos.recordReply(PHONE);
  const closed = await convos.closeConversation(PHONE, { status: 'handed_off', reason: 'a recruiter replied' });
  assert.equal(closed.status, 'handed_off');
  assert.equal(closed.repliesSent, 1);
  assert.match(closed.stopReason, /recruiter replied/);
});

test('only the three known statuses are storable', async (t) => {
  if (await skipWithoutPg(t)) return;
  const h = await seed(t);
  const { recruitingConversations: convos } = loadConvos(h);
  await convos.ensureConversation({ driverPhone: PHONE });
  await assert.rejects(
    () => h.query('UPDATE recruiting_ai_conversations SET status = $1 WHERE driver_phone = $2', ['paused', PHONE]),
    /status/,
  );
});

test('a candidate thread is readable by phone, newest first and capped', async (t) => {
  if (await skipWithoutPg(t)) return;
  const h = await seed(t);
  const { 'facebookLeads/smsMirrors': mirrors } = loadMirrors(h);

  const kinds = ['outbound_auto', 'inbound_rc', 'outbound_ai', 'outbound_recruiter'];
  for (let i = 0; i < kinds.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await mirrors.insertFacebookLeadSmsMirror({
      telegramChatId: -100123, telegramMessageId: 100 + i,
      driverPhone: PHONE, smsBody: `message ${i}`, sourceType: kinds[i],
    });
  }
  // A different candidate, who must not appear.
  await mirrors.insertFacebookLeadSmsMirror({
    telegramChatId: -100123, telegramMessageId: 200,
    driverPhone: '+15559999999', smsBody: 'someone else', sourceType: 'inbound_rc',
  });

  const rows = await mirrors.listSmsMirrorsByPhone(PHONE);
  assert.equal(rows.length, 4);
  assert.ok(rows.every((r) => r.driver_phone === PHONE));
  assert.deepEqual(
    [...new Set(rows.map((r) => r.source_type))].sort(),
    ['inbound_rc', 'outbound_ai', 'outbound_auto', 'outbound_recruiter'],
    'all four kinds are storable — outbound_recruiter and outbound_ai are new',
  );

  const capped = await mirrors.listSmsMirrorsByPhone(PHONE, { limit: 2 });
  assert.equal(capped.length, 2);
  assert.equal(capped[0].sms_body, 'message 3', 'newest first, so a LIMIT keeps the recent end');

  assert.deepEqual(await mirrors.listSmsMirrorsByPhone(''), [], 'no phone, no thread');
});

test('the capability the reply runs under is registered and cannot self-apply', async (t) => {
  if (await skipWithoutPg(t)) return;
  const h = await seed(t);
  const { rows } = await h.query(
    'SELECT * FROM ai_capabilities WHERE capability_key = $1',
    ['recruiting_after_hours_reply'],
  );
  assert.equal(rows.length, 1, 'migration 0035 registers it');
  assert.equal(rows[0].sends_raw_text, true, 'the candidate\'s own words go to a provider; the screen says so');
  assert.equal(rows[0].has_deterministic_fallback, true);
  assert.equal(rows[0].may_auto_apply, false, 'the schema CHECK holds for this one too');
});
