/**
 * Migration 0008 against a REAL PostgreSQL, on the real baseline schema.
 *
 * What is worth proving here is what a unit test cannot: that the migration
 * applies to the accumulated schema, that it is idempotent (a re-run on a boot
 * that already has it must be a no-op, per CLAUDE.md), that the new columns
 * accept and constrain what the application writes, and that the uniqueness of
 * `bitrix_user_id` really is enforced by the database rather than by hope — one
 * Bitrix user must never resolve to two recruiters, or a lead's sender would be
 * a coin flip.
 *
 * Needs TEST_DATABASE_URL and SKIPS without it. A skipped test is not a
 * passing test (CLAUDE.md); CI fails on any skip.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const MIGRATION_PATH = path.join(__dirname, '..', 'database', 'migrations', '0008_recruiter_sms_sender_identity.sql');
const MIGRATION = fs.readFileSync(MIGRATION_PATH, 'utf8');

// The subtests that write THROUGH the data layer need the schema the data
// layer actually knows, not just 0008's slice of it — a later migration adding
// a column those writers set would otherwise fail a test that is correct about
// 0008. The DDL assertions below still name 0008's own columns explicitly.
const ALL_MIGRATIONS = allMigrationsSql();

/** Column names on a table, as PostgreSQL sees them. */
async function columnsOf(harness, table) {
  const res = await harness.query(
    `SELECT column_name, is_nullable, data_type
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`,
    [table]
  );
  return new Map(res.rows.map((row) => [row.column_name, row]));
}

test('the migration adds every column the sender identity needs', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: MIGRATION });

  const recruiters = await columnsOf(harness, 'recruiters');
  for (const column of [
    'bitrix_user_id', 'refresh_token_encrypted', 'rc_extension_id',
    'rc_extension_number', 'rc_authorized_at', 'rc_token_refreshed_at', 'rc_auth_error',
  ]) {
    assert.ok(recruiters.has(column), `recruiters.${column} must exist`);
    assert.equal(recruiters.get(column).is_nullable, 'YES', `recruiters.${column} must be nullable`);
  }

  const leads = await columnsOf(harness, 'leads');
  for (const column of ['bitrix_assigned_by_id', 'sms_from_number', 'sms_sender_recruiter_id']) {
    assert.ok(leads.has(column), `leads.${column} must exist`);
  }

  const mirrors = await columnsOf(harness, 'facebook_lead_sms_mirrors');
  for (const column of ['recruiter_id', 'from_number']) {
    assert.ok(mirrors.has(column), `facebook_lead_sms_mirrors.${column} must exist`);
  }

  const sessions = await columnsOf(harness, 'ringcentral_connect_sessions');
  for (const column of ['session_token', 'recruiter_id', 'oauth_state', 'status', 'expires_at']) {
    assert.ok(sessions.has(column), `ringcentral_connect_sessions.${column} must exist`);
  }
});

test('applying it twice changes nothing — every boot re-runs the baseline', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: MIGRATION });
  // Deliberately a THIRD application: idempotency has to survive repetition,
  // not just one retry after a mid-way failure.
  await harness.query(MIGRATION);
  await harness.query(MIGRATION);

  const recruiters = await columnsOf(harness, 'recruiters');
  assert.ok(recruiters.has('bitrix_user_id'));
  const indexes = await harness.query(
    `SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'recruiters'
        AND indexname = 'idx_recruiters_bitrix_user_id'`
  );
  assert.equal(indexes.rows.length, 1, 'the unique index exists exactly once');
});

test('one Bitrix user maps to at most one recruiter', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: MIGRATION });
  const insert = (name, number, bitrixUserId) => harness.query(
    `INSERT INTO recruiters (name, phone_number, phone_number_normalized, bitrix_user_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [name, number, number.replace(/\D/g, '').slice(-10), bitrixUserId]
  );

  await insert('Jane Doe', '+15550001111', 17);
  await assert.rejects(
    () => insert('Bob Roe', '+15550002222', 17),
    (err) => err.code === '23505',
    'a second recruiter claiming Bitrix user 17 must be rejected by the database',
  );

  // …but any number of recruiters may have no Bitrix user at all.
  await insert('Unmapped One', '+15550003333', null);
  await insert('Unmapped Two', '+15550004444', null);
  const unmapped = await harness.query('SELECT count(*)::int AS n FROM recruiters WHERE bitrix_user_id IS NULL');
  assert.equal(unmapped.rows[0].n, 2);
});

test('deleting a recruiter does not delete the history that points at them', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: MIGRATION });
  const inserted = await harness.query(
    `INSERT INTO recruiters (name, phone_number, phone_number_normalized, bitrix_user_id)
     VALUES ('Jane Doe', '+15550001111', '5550001111', 17) RETURNING id`
  );
  const recruiterId = inserted.rows[0].id;

  await harness.query(
    `INSERT INTO leads (source, external_id, full_name, bitrix_assigned_by_id, sms_from_number, sms_sender_recruiter_id)
     VALUES ('facebook', 'lg-1', 'Alex Driver', 17, '+15550001111', $1)`,
    [recruiterId]
  );
  await harness.query(
    `INSERT INTO facebook_lead_sms_mirrors
       (telegram_chat_id, telegram_message_id, driver_phone, sms_body, recruiter_id, from_number)
     VALUES (-100999, 42, '+15559998888', 'Hi Alex', $1, '+15550001111')`,
    [recruiterId]
  );

  await harness.query('DELETE FROM recruiters WHERE id = $1', [recruiterId]);

  // ON DELETE SET NULL: a departed recruiter must not erase the lead or the
  // conversation, only the link to their row.
  const lead = await harness.query('SELECT * FROM leads WHERE external_id = $1', ['lg-1']);
  assert.equal(lead.rows.length, 1, 'the lead survives');
  assert.equal(lead.rows[0].sms_sender_recruiter_id, null);
  assert.equal(lead.rows[0].sms_from_number, '+15550001111', 'which number texted them is still known');
  assert.equal(lead.rows[0].bitrix_assigned_by_id, 17);

  const mirror = await harness.query('SELECT * FROM facebook_lead_sms_mirrors WHERE telegram_message_id = 42');
  assert.equal(mirror.rows.length, 1, 'the mirror survives');
  assert.equal(mirror.rows[0].recruiter_id, null);
  assert.equal(mirror.rows[0].from_number, '+15550001111');
});

test('a connect session is single-use by construction', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: MIGRATION });
  const expires = new Date(Date.now() + 60_000);

  await harness.query(
    `INSERT INTO ringcentral_connect_sessions (session_token, oauth_state, expires_at)
     VALUES ('tok-1', 'state-1', $1)`,
    [expires]
  );

  // The token IS the credential, so it cannot be shared between sessions…
  await assert.rejects(
    () => harness.query(
      `INSERT INTO ringcentral_connect_sessions (session_token, expires_at) VALUES ('tok-1', $1)`,
      [expires]
    ),
    (err) => err.code === '23505',
  );
  // …and neither can the CSRF state that binds a redirect to a callback.
  await assert.rejects(
    () => harness.query(
      `INSERT INTO ringcentral_connect_sessions (session_token, oauth_state, expires_at)
       VALUES ('tok-2', 'state-1', $1)`,
      [expires]
    ),
    (err) => err.code === '23505',
  );

  const row = await harness.query('SELECT status FROM ringcentral_connect_sessions WHERE session_token = $1', ['tok-1']);
  assert.equal(row.rows[0].status, 'pending', 'a new link starts pending');
});

test('a session dies with the recruiter it was created for', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: MIGRATION });
  const inserted = await harness.query(
    `INSERT INTO recruiters (name, phone_number, phone_number_normalized)
     VALUES ('Jane Doe', '+15550001111', '5550001111') RETURNING id`
  );
  await harness.query(
    `INSERT INTO ringcentral_connect_sessions (session_token, recruiter_id, expires_at)
     VALUES ('tok-1', $1, $2)`,
    [inserted.rows[0].id, new Date(Date.now() + 60_000)]
  );

  await harness.query('DELETE FROM recruiters WHERE id = $1', [inserted.rows[0].id]);
  // ON DELETE CASCADE: an invite for someone who no longer exists is not a
  // link anyone should be able to open.
  const left = await harness.query('SELECT count(*)::int AS n FROM ringcentral_connect_sessions');
  assert.equal(left.rows[0].n, 0);
});

test('the data layer reads and writes the new columns for real', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { ringcentral } = harness.loadDataLayer(['ringcentral']);

  const created = await ringcentral.createRecruiter({
    name: 'Jane Doe',
    phoneNumber: '+1 (555) 000-1111',
    bitrixUserId: '17',
    jwtToken: 'her-own-jwt',
  });
  assert.equal(created.bitrixUserId, 17, 'the admin form sends a string; the column is an integer');
  assert.equal(created.authMode, 'jwt');
  assert.equal(created.canSendSms, true);

  // hasMappedSmsSenders is the pre-check that keeps an unconfigured deployment
  // from paying for a Bitrix round trip on every lead.
  assert.equal(await ringcentral.hasMappedSmsSenders(), true);

  const byBitrix = await ringcentral.getRecruiterByBitrixUserId(17);
  assert.equal(byBitrix.id, created.id);
  assert.equal(await ringcentral.getRecruiterByBitrixUserId(999), null);
  assert.equal(await ringcentral.getRecruiterByBitrixUserId(null), null, 'an unassigned lead asks for nobody');

  // A completed RingCentral sign-in: token stored, identity recorded, and any
  // previous auth error cleared because a fresh login is what fixes one.
  await ringcentral.markRecruiterAuthError(created.id, 'expired');
  await ringcentral.storeRecruiterOAuthTokens(created.id, {
    refreshToken: 'refresh-1',
    extensionId: '101',
    extensionNumber: '1001',
  });
  let row = await ringcentral.getRecruiterById(created.id);
  assert.equal(row.rc_extension_id, '101');
  assert.equal(row.rc_auth_error, null);
  assert.ok(row.rc_authorized_at instanceof Date);
  const cfg = { apiBase: 'https://rc.test', clientId: 'cid', clientSecret: 'sec' };
  assert.equal(ringcentral.resolveRecruiterRcAuth(row, cfg).mode, 'oauth', 'a login outranks the pasted JWT');
  assert.equal(ringcentral.resolveRecruiterRcAuth(row, cfg).refreshToken, 'refresh-1');

  // Rotation: a refresh must replace the stored token, or the recruiter stops
  // sending about a week later.
  await ringcentral.updateRecruiterRefreshToken(created.id, 'refresh-2');
  row = await ringcentral.getRecruiterById(created.id);
  assert.equal(ringcentral.resolveRecruiterRcAuth(row, cfg).refreshToken, 'refresh-2');

  const withCreds = await ringcentral.listRecruitersWithOwnCredentials();
  assert.deepEqual(withCreds.map((r) => r.id), [created.id]);

  // Forgetting the login leaves the JWT, and the recruiter, intact.
  const cleared = await ringcentral.clearRecruiterOAuth(created.id);
  assert.equal(cleared.oauthConnected, false);
  assert.equal(cleared.authMode, 'jwt');
  assert.equal(cleared.bitrixUserId, 17);

  // Clearing the Bitrix mapping is an explicit blank, not an omission.
  const unmapped = await ringcentral.updateRecruiter(created.id, { bitrixUserId: '' });
  assert.equal(unmapped.bitrixUserId, null);
  assert.equal(await ringcentral.hasMappedSmsSenders(), false);

  const untouched = await ringcentral.updateRecruiter(created.id, { name: 'Jane D.' });
  assert.equal(untouched.name, 'Jane D.');
  assert.equal(untouched.bitrixUserId, null);
});

test('the mirror ledger stores its sender through the data layer', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { facebookLeads, ringcentral } = harness.loadDataLayer(['facebookLeads', 'ringcentral']);

  const recruiter = await ringcentral.createRecruiter({
    name: 'Jane Doe', phoneNumber: '+15550001111', refreshToken: 'refresh-1',
  });
  const stored = await facebookLeads.insertFacebookLeadSmsMirror({
    telegramChatId: -100999,
    telegramMessageId: 42,
    driverPhone: '+15559998888',
    smsBody: 'Hi Alex',
    recruiterId: recruiter.id,
    fromNumber: '+15550001111',
  });
  assert.equal(stored.recruiter_id, recruiter.id);
  assert.equal(stored.from_number, '+15550001111');

  // The upsert must carry the sender too: a re-registered mirror that lost it
  // would answer the driver from the wrong number.
  const again = await facebookLeads.insertFacebookLeadSmsMirror({
    telegramChatId: -100999,
    telegramMessageId: 42,
    driverPhone: '+15559998888',
    smsBody: 'Hi Alex again',
    recruiterId: recruiter.id,
    fromNumber: '+15550001111',
  });
  assert.equal(again.id, stored.id, 'same mirror row');
  assert.equal(again.recruiter_id, recruiter.id);
  assert.equal(again.from_number, '+15550001111');
});

test('a lead remembers who was assigned it and who texted them', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { leads, ringcentral } = harness.loadDataLayer(['leads', 'ringcentral']);

  const recruiter = await ringcentral.createRecruiter({
    name: 'Jane Doe', phoneNumber: '+15550001111', bitrixUserId: 17, refreshToken: 'r',
  });
  const lead = await leads.createLeadIfNew({
    source: 'facebook', externalId: 'lg-1', fullName: 'Alex Driver', phone: '+15559998888',
  });
  await leads.updateLeadSmsSender(lead.id, {
    assignedById: 17, fromNumber: '+15550001111', recruiterId: recruiter.id,
  });

  let [row] = (await harness.query('SELECT * FROM leads WHERE id = $1', [lead.id])).rows;
  assert.equal(row.bitrix_assigned_by_id, 17);
  assert.equal(row.sms_from_number, '+15550001111');
  assert.equal(row.sms_sender_recruiter_id, recruiter.id);

  // COALESCE, so a later best-effort call with nothing new cannot blank it.
  await leads.updateLeadSmsSender(lead.id, {});
  [row] = (await harness.query('SELECT * FROM leads WHERE id = $1', [lead.id])).rows;
  assert.equal(row.bitrix_assigned_by_id, 17);
  assert.equal(row.sms_from_number, '+15550001111');
});

test('replacing a recruiter’s credentials clears the extension recorded against the old one',
  { skip: skipWithoutPg() }, async (t) => {
    // A new JWT may belong to a DIFFERENT RingCentral account — that is exactly
    // what an admin does to fix a wrong-account setup. The extension recorded
    // against the old credential is then a stranger's, and because
    // `recruiterExtensionIdentity` only re-reads an identity that is MISSING, a
    // stale one would never be corrected: the subscription keeps watching the
    // old extension while replies to the number they now text from reach
    // nobody.
    const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
    const { ringcentral } = harness.loadDataLayer(['ringcentral']);

    const created = await ringcentral.createRecruiter({
      name: 'Kimberly', phoneNumber: '(470) 419-4110', jwtToken: 'first-account-jwt',
    });
    await ringcentral.updateRecruiterRcIdentity(created.id, {
      extensionId: '80055512', extensionNumber: '101',
    });
    const before = await ringcentral.getRecruiterById(created.id);
    assert.equal(before.rc_extension_id, '80055512');

    // An ordinary edit must NOT throw the identity away — the admin panel sends
    // no secret unless one was typed, and re-reading it costs a request.
    await ringcentral.updateRecruiter(created.id, { name: 'Kimberly R.' });
    const renamed = await ringcentral.getRecruiterById(created.id);
    assert.equal(renamed.name, 'Kimberly R.');
    assert.equal(renamed.rc_extension_id, '80055512', 'a rename keeps the identity');

    // Pasting a new credential does.
    await ringcentral.updateRecruiter(created.id, { jwtToken: 'second-account-jwt' });
    const swapped = await ringcentral.getRecruiterById(created.id);
    assert.equal(swapped.rc_extension_id, null, 'the stale extension is dropped');
    assert.equal(swapped.rc_extension_number, null);
    assert.ok(swapped.jwt_token_encrypted, 'and the new credential is stored');

    // So does clearing one, which is the same reasoning in reverse.
    await ringcentral.updateRecruiterRcIdentity(created.id, { extensionId: '80099999' });
    await ringcentral.updateRecruiter(created.id, { clearJwtToken: true });
    const cleared = await ringcentral.getRecruiterById(created.id);
    assert.equal(cleared.rc_extension_id, null);
  });
