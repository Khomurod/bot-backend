/**
 * The narrowed RingCentral reads and the skipped call writes, on a real
 * PostgreSQL with the real schema.
 *
 * October 2026, to save database transfer: the settings row is read by name
 * and kept until it changes; the call sync reads seven recruiter columns and
 * re-reads them only when a hash of exactly those columns changes; the leads
 * worker's extension check reads three; and a call already written with the
 * same values is not written again. What a unit test with a fake database
 * cannot prove, and this does:
 *   - the column lists cover every field their callers read (compared with
 *     what the old `SELECT *` produced);
 *   - the roster hash really changes when a credential rotates or another
 *     process writes, and really does NOT when an unrelated column changes;
 *   - a write the database refused is never remembered as written.
 *
 * Needs TEST_DATABASE_URL and SKIPS without it. A skipped test is not a
 * passing test (CLAUDE.md); CI fails on any skip.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');
const { purgeDataLayer, POOL_PATH } = require('./helpers/purgeDataLayer');
const { encryptText } = require('../lib/security/facebookCrypto');
const { maskKey } = require('../lib/security/secretMasking');
const { DEFAULT_TARGET_TALK_SECONDS, formatTalkLabel } = require('../database/ringcentral/kpiMath');

const ALL_MIGRATIONS = allMigrationsSql();
const SYNC_COLUMNS = [
  'id', 'name', 'phone_number', 'phone_number_normalized', 'rc_extension_id',
  'jwt_token_encrypted', 'client_id_encrypted', 'client_secret_encrypted', 'refresh_token_encrypted',
];

/** The real data layer on the throwaway database, recording every statement. */
function loadRingcentral(harness) {
  const statements = [];
  purgeDataLayer();
  require.cache[POOL_PATH] = {
    id: POOL_PATH, filename: POOL_PATH, loaded: true,
    exports: {
      pool: harness.pool,
      query: (text, values) => { statements.push(text.replace(/\s+/g, ' ').trim()); return harness.pool.query(text, values); },
      ping: async () => true,
    },
  };
  try {
    // eslint-disable-next-line global-require
    return { ringcentral: require('../database/ringcentral'), statements };
  } finally {
    delete require.cache[POOL_PATH];
    purgeDataLayer();
  }
}

/** The configuration the old code built from `SELECT *` (env fallbacks unset here). */
function legacyConfig(row) {
  const dec = (v) => (v ? require('../lib/security/facebookCrypto').decryptText(v) : '');
  return {
    enabled: row ? row.enabled === true : false,
    apiBase: (row?.api_base || 'https://platform.ringcentral.com').replace(/\/+$/, ''),
    clientId: dec(row?.client_id_encrypted), clientSecret: dec(row?.client_secret_encrypted), jwtToken: dec(row?.jwt_token_encrypted),
    pollMinutes: row?.poll_minutes || 10, timezone: row?.timezone || 'America/Chicago',
    nonValuableMaxSeconds: row?.non_valuable_max_seconds ?? 30,
    realConversationMinSeconds: row?.real_conversation_min_seconds ?? 60,
    strongConversationMinSeconds: row?.strong_conversation_min_seconds ?? 180,
    targetTalkSeconds: row?.target_talk_seconds ?? DEFAULT_TARGET_TALK_SECONDS,
    targetOutbound: row?.target_outbound ?? 150, targetRealConversations: row?.target_real_conversations ?? 35,
    lastSyncedAt: row?.last_synced_at || null, lastSyncError: row?.last_sync_error || null,
  };
}

/** The masked admin view the old code built from `SELECT *`. */
function legacyAdminView(row) {
  const cfg = legacyConfig(row);
  return {
    enabled: cfg.enabled, apiBase: cfg.apiBase,
    clientIdSet: Boolean(cfg.clientId), clientIdMasked: maskKey(cfg.clientId),
    clientSecretSet: Boolean(cfg.clientSecret), clientSecretMasked: maskKey(cfg.clientSecret),
    jwtTokenSet: Boolean(cfg.jwtToken), jwtTokenMasked: maskKey(cfg.jwtToken),
    fromEnv: {
      clientId: !row?.client_id_encrypted && Boolean(cfg.clientId),
      clientSecret: !row?.client_secret_encrypted && Boolean(cfg.clientSecret),
      jwtToken: !row?.jwt_token_encrypted && Boolean(cfg.jwtToken),
    },
    pollMinutes: cfg.pollMinutes, timezone: cfg.timezone,
    nonValuableMaxSeconds: cfg.nonValuableMaxSeconds,
    realConversationMinSeconds: cfg.realConversationMinSeconds,
    strongConversationMinSeconds: cfg.strongConversationMinSeconds,
    targetTalkSeconds: cfg.targetTalkSeconds, targetTalkMinutes: Math.round(cfg.targetTalkSeconds / 60),
    targetTalkLabel: formatTalkLabel(cfg.targetTalkSeconds),
    targetOutbound: cfg.targetOutbound, targetRealConversations: cfg.targetRealConversations,
    lastSyncedAt: cfg.lastSyncedAt, lastSyncError: cfg.lastSyncError, updatedAt: row?.updated_at || null,
  };
}

const storedSettings = async (harness) => (await harness.query('SELECT * FROM ringcentral_settings WHERE id = 1')).rows[0];

test('the settings read by name covers every field the configuration and the admin view use', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { ringcentral, statements } = loadRingcentral(harness);
  await ringcentral.updateRcSettings({
    enabled: true, apiBase: 'https://platform.devtest.ringcentral.com/', clientId: 'client-id-123456',
    clientSecret: 'client-secret-123456', jwtToken: 'jwt-token-1234567890', pollMinutes: 7, timezone: 'America/Denver',
    nonValuableMaxSeconds: 45, realConversationMinSeconds: 90, strongConversationMinSeconds: 240,
    targetTalkMinutes: 120, targetOutbound: 99, targetRealConversations: 12,
  });
  await ringcentral.markSyncResult({ error: 'boom' });

  const admin = await ringcentral.getRcSettingsForAdmin();
  assert.equal(JSON.stringify(admin), JSON.stringify(legacyAdminView(await storedSettings(harness))));

  ringcentral.invalidateSettingsCache();
  const cfg = await ringcentral.getRcConfig();
  assert.equal(JSON.stringify(cfg), JSON.stringify(legacyConfig(await storedSettings(harness))));
  assert.deepEqual(statements.filter((s) => /SELECT \*/i.test(s)), [], 'no whole-row settings read');
});

test('the sync stamp: the admin view shows the stored one, and the cached configuration is updated without a read', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { ringcentral, statements } = loadRingcentral(harness);
  await ringcentral.getRcConfig();
  statements.length = 0;
  await ringcentral.markSyncResult({ error: 'boom' });
  const cfg = await ringcentral.getRcConfig();
  assert.equal(statements.length, 1, `only the stamp itself:\n${statements.join('\n')}`);
  assert.equal(cfg.lastSyncError, 'boom');
  assert.ok(cfg.lastSyncedAt instanceof Date);

  const admin = await ringcentral.getRcSettingsForAdmin();
  const stored = await storedSettings(harness);
  assert.equal(admin.lastSyncError, 'boom');
  assert.equal(admin.lastSyncedAt.getTime(), stored.last_synced_at.getTime(), 'the database time, not the app clock');
});

async function seedRecruiters(ringcentral) {
  const jane = await ringcentral.createRecruiter({ name: 'Jane', phoneNumber: '+1 (470) 480-4679', jwtToken: 'jane-jwt' });
  const bob = await ringcentral.createRecruiter({ name: 'Bob', phoneNumber: '212-555-1234' });
  const cara = await ringcentral.createRecruiter({
    name: 'Cara', phoneNumber: '3125550000', refreshToken: 'refresh-1', clientId: 'own-client', clientSecret: 'own-secret',
  });
  const dan = await ringcentral.createRecruiter({ name: 'Dan', phoneNumber: '4155550000', jwtToken: 'dan-jwt', active: false });
  const eve = await ringcentral.createRecruiter({ name: 'Eve', phoneNumber: '6465550000', jwtToken: 'eve-jwt' });
  await ringcentral.updateRecruiterRcIdentity(jane.id, { extensionId: '101' });
  await ringcentral.updateRecruiterRcIdentity(eve.id, { extensionId: '105' });
  return { jane, bob, cara, dan, eve };
}

test('the call-sync roster: the same recruiters in the same order, nine columns, re-read only when they change', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { ringcentral, statements } = loadRingcentral(harness);
  const { jane, bob, cara } = await seedRecruiters(ringcentral);
  const cfg = await ringcentral.getRcConfig();

  const first = await ringcentral.listRecruitersForCallSync();
  const old = (await harness.query('SELECT * FROM recruiters WHERE active = TRUE ORDER BY name ASC')).rows;
  const project = (row) => Object.fromEntries(SYNC_COLUMNS.map((c) => [c, row[c]]));
  assert.deepEqual(first, old.map(project), 'the rows and order the old SELECT * gave, cut to what the sync reads');
  assert.deepEqual(Object.keys(first[0]).sort(), [...SYNC_COLUMNS].sort());

  const read = async () => { statements.length = 0; const rows = await ringcentral.listRecruitersForCallSync(); return { rows, count: statements.length }; };
  const auth = (rows, id) => ringcentral.resolveRecruiterRcAuth(rows.find((r) => r.id === id), cfg);

  first[0].name = 'scribbled on by a caller';
  let next = await read();
  assert.equal(next.count, 1, 'unchanged: one small hash, no rows');
  assert.deepEqual(next.rows, old.map(project), 'and a caller cannot change what the next pass sees');

  await ringcentral.updateRecruiterRefreshToken(cara.id, 'refresh-2');
  next = await read();
  assert.equal(next.count, 2, 'a rotated refresh token is re-read');
  assert.equal(auth(next.rows, cara.id).refreshToken, 'refresh-2', 'and it is the new token the pass would use');

  await ringcentral.markRecruiterAuthError(cara.id, 'needs sign-in');
  next = await read();
  assert.equal(next.count, 1, 'a column the roster does not carry costs no re-read');

  // The extension id IS carried (resolveRecruiterRcAuth copies it into the
  // auth), so a change to it is re-read like any other.
  await ringcentral.updateRecruiterRcIdentity(bob.id, { extensionId: '102' });
  next = await read();
  assert.equal(next.count, 2, 'a carried identity field is re-read when it changes');
  assert.equal(auth(next.rows, bob.id).extensionId, '102');

  await harness.query('UPDATE recruiters SET jwt_token_encrypted = $1 WHERE id = $2', [encryptText('bob-jwt'), bob.id]);
  next = await read();
  assert.equal(next.count, 2, 'a write by another process is seen on the next pass');
  assert.equal(auth(next.rows, bob.id).mode, 'jwt');

  await ringcentral.updateRecruiter(jane.id, { active: false });
  next = await read();
  assert.ok(!next.rows.some((r) => r.id === jane.id), 'a deactivated recruiter leaves the roster');
});

test("the leads worker's extension roster: the recruiters it always listed, in order, three columns", { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { ringcentral, statements } = loadRingcentral(harness);
  await seedRecruiters(ringcentral);
  const full = await ringcentral.listRecruitersWithOwnCredentials();
  statements.length = 0;
  const narrow = await ringcentral.listRecruiterSmsExtensions();
  assert.deepEqual(narrow, full.map(({ id, name, rc_extension_id: ext }) => ({ id, name, rc_extension_id: ext })));
  assert.deepEqual(narrow.map((r) => r.name), ['Cara', 'Eve', 'Jane'], 'active, with credentials, by name');
  assert.equal(statements.length, 1);
  assert.doesNotMatch(statements[0], /SELECT \*/i);
});

test('a call is written once, skipped while unchanged, written when it changes — and a refused write is not remembered', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { ringcentral, statements } = loadRingcentral(harness);
  const call = {
    id: 'rc-1', sessionId: 's-1', recruiterId: null, recruiterNumberNormalized: null, direction: 'Outbound',
    result: 'Accepted', fromNumber: '+14704804679', toNumber: '+15550001111', durationSeconds: 30,
    callTime: '2026-10-09T14:00:00.000Z',
  };
  const stored = async () => (await harness.query('SELECT duration_seconds FROM ringcentral_calls WHERE id = $1', ['rc-1'])).rows[0]?.duration_seconds;

  assert.equal(await ringcentral.upsertCall(call), true);
  assert.equal(await stored(), 30);
  statements.length = 0;
  assert.equal(await ringcentral.upsertCall({ ...call }), false, 'the same values are not sent again');
  assert.deepEqual(statements, []);
  assert.equal(await ringcentral.upsertCall({ ...call, durationSeconds: 95 }), true, 'a finalized duration is');
  assert.equal(await stored(), 95);

  await harness.query('ALTER TABLE ringcentral_calls ADD CONSTRAINT test_refuses_777 CHECK (duration_seconds <> 777)');
  await assert.rejects(ringcentral.upsertCall({ ...call, durationSeconds: 777 }));
  await harness.query('ALTER TABLE ringcentral_calls DROP CONSTRAINT test_refuses_777');
  assert.equal(await ringcentral.upsertCall({ ...call, durationSeconds: 95 }), true,
    'after a failure nothing about this call is taken on trust — not even the last good write');
  assert.equal(await ringcentral.upsertCall({ ...call, durationSeconds: 777 }), true);
  assert.equal(await stored(), 777);
});
