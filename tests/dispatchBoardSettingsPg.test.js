'use strict';

/**
 * The Board's connection store, against the real schema.
 *
 * A stubbed client answers whatever it is told to, so a stub cannot catch a
 * column that does not exist, a CHECK that refuses a value, or — the one this
 * table exists to prevent — a token reaching a column that is read back to a
 * browser. This drives the real table.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();

const BASE = 'https://script.example.com/macros/s/AKfycbX/exec';
const TOKEN = 'Sh4red-T0ken-ThatMustNeverAppear';

async function setup(t) {
  process.env.FACEBOOK_CRYPTO_SECRET ||= 'a-test-secret-for-encrypting-values';
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const layer = h.loadDataLayer(['dispatchBoardSettings']);
  return { h, board: layer.dispatchBoardSettings };
}

test('the migration seeds exactly one row, and it is off', { skip: skipWithoutPg() }, async (t) => {
  const { h, board } = await setup(t);
  const rows = await h.query('SELECT id, enabled, base_url, token_encrypted FROM dispatch_board_settings');
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].id, 1);
  assert.equal(rows.rows[0].enabled, false, 'an integration must not switch itself on at deploy');
  assert.equal(rows.rows[0].base_url, null);

  const cfg = await board.getBoardConfig();
  assert.equal(cfg.configured, false);
});

test('applying the migrations twice is a no-op', { skip: skipWithoutPg() }, async (t) => {
  const { h } = await setup(t);
  await h.query(ALL_MIGRATIONS);
  const rows = await h.query('SELECT COUNT(*)::int AS n FROM dispatch_board_settings');
  assert.equal(rows.rows[0].n, 1, 'a re-applied migration must not add a second row');
});

test('the token is stored encrypted and never comes back raw', { skip: skipWithoutPg() }, async (t) => {
  const { h, board } = await setup(t);
  const view = await board.updateBoardSettings({ baseUrl: BASE, token: TOKEN }, { updatedBy: 'admin' });

  const stored = await h.query('SELECT token_encrypted, token_last4 FROM dispatch_board_settings WHERE id = 1');
  assert.ok(stored.rows[0].token_encrypted, 'something was stored');
  assert.ok(!String(stored.rows[0].token_encrypted).includes(TOKEN), 'and it is not the token');
  assert.equal(stored.rows[0].token_last4, 'pear');

  assert.equal(view.tokenSet, true);
  assert.ok(!JSON.stringify(view).includes(TOKEN), 'the admin view must never carry it');

  // But the server can still use it.
  const cfg = await board.getBoardConfig();
  assert.equal(cfg.token, TOKEN);
  assert.equal(cfg.configured, true);
});

test('omitting the token keeps it; clearing it removes it', { skip: skipWithoutPg() }, async (t) => {
  const { board } = await setup(t);
  await board.updateBoardSettings({ baseUrl: BASE, token: TOKEN });

  await board.updateBoardSettings({ enabled: true });
  assert.equal((await board.getBoardConfig()).token, TOKEN, 'omit means keep');

  await board.updateBoardSettings({ clearToken: true });
  const cleared = await board.getBoardConfig();
  assert.equal(cleared.token, '');
  assert.equal(cleared.configured, false);
});

test('a base URL that is not a URL is treated as not configured', { skip: skipWithoutPg() }, async (t) => {
  const { board } = await setup(t);
  await board.updateBoardSettings({ baseUrl: 'paste the link here', token: TOKEN });
  const cfg = await board.getBoardConfig();
  assert.equal(cfg.baseUrl, null, 'rather than handed to fetch to find out');
  assert.equal(cfg.configured, false);
});

test('the poll interval is clamped in JS to what the CHECK allows', { skip: skipWithoutPg() }, async (t) => {
  const { board } = await setup(t);
  // A value outside the range must never reach the statement — it would be a
  // 500 on a settings form instead of a sensible number.
  await board.updateBoardSettings({ pollIntervalSeconds: 5 });
  assert.equal((await board.getBoardConfig()).pollIntervalSeconds, 60);
  await board.updateBoardSettings({ pollIntervalSeconds: 99999 });
  assert.equal((await board.getBoardConfig()).pollIntervalSeconds, 3600);
});

test('the CHECK itself refuses an out-of-range interval', { skip: skipWithoutPg() }, async (t) => {
  const { h } = await setup(t);
  await assert.rejects(
    () => h.query('UPDATE dispatch_board_settings SET poll_interval_seconds = 5 WHERE id = 1'),
    /violates check constraint/i
  );
});

test('a poll outcome records the error with its URL stripped', { skip: skipWithoutPg() }, async (t) => {
  const { h, board } = await setup(t);
  await board.recordPollOutcome({
    ok: false,
    error: `request to ${BASE}?token=${TOKEN} failed`,
  });
  const row = await h.query('SELECT last_poll_ok, last_error, last_poll_at FROM dispatch_board_settings WHERE id = 1');
  assert.equal(row.rows[0].last_poll_ok, false);
  assert.ok(row.rows[0].last_poll_at, 'the attempt is recorded even when it failed');
  assert.ok(!row.rows[0].last_error.includes(TOKEN), row.rows[0].last_error);
  assert.ok(!row.rows[0].last_error.includes('script.example.com'), row.rows[0].last_error);
  assert.match(row.rows[0].last_error, /<url>/);
});

test('a successful poll records what it read', { skip: skipWithoutPg() }, async (t) => {
  const { board } = await setup(t);
  await board.recordPollOutcome({
    ok: true, count: 102, boardDate: '2026-09-12', generatedAt: '2026-09-12T00:00:00Z',
  });
  const cfg = await board.getBoardConfig();
  assert.equal(cfg.lastPollOk, true);
  assert.equal(cfg.lastPollCount, 102);
  assert.equal(cfg.lastPollBoardDate, '2026-09-12');
  assert.equal(cfg.lastError, null, 'a success clears the last failure');
});

test('a second row can never be inserted', { skip: skipWithoutPg() }, async (t) => {
  const { h } = await setup(t);
  await assert.rejects(
    () => h.query('INSERT INTO dispatch_board_settings (id) VALUES (2)'),
    /violates check constraint/i
  );
});

// ── a credential must never land in the plaintext URL column ─────────────────
//
// The Board's own links carry `?token=…`, so an administrator pasting "the
// link" pastes the credential with it. Stored as typed, it sits in plaintext in
// a column the settings GET returns verbatim — around the encrypted, masked
// field built to hold exactly that value.

test('a token pasted inside the URL is moved into the encrypted field', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { h, board } = await setup(t);
  const view = await board.updateBoardSettings({ baseUrl: `${BASE}?token=${TOKEN}` });

  const row = await h.query('SELECT base_url, token_encrypted FROM dispatch_board_settings WHERE id = 1');
  assert.ok(!row.rows[0].base_url.includes(TOKEN), `stored URL still carries it: ${row.rows[0].base_url}`);
  assert.ok(!row.rows[0].base_url.includes('token='), row.rows[0].base_url);
  assert.ok(!JSON.stringify(view).includes(TOKEN), 'and the admin view never shows it');

  // It is not lost — it ended up where it belongs, and the connection works.
  const cfg = await board.getBoardConfig();
  assert.equal(cfg.token, TOKEN);
  assert.equal(cfg.configured, true);
});

test('an explicit token wins over one hidden in the URL', { skip: skipWithoutPg() }, async (t) => {
  const { board } = await setup(t);
  await board.updateBoardSettings({ baseUrl: `${BASE}?token=stale-one`, token: TOKEN });
  assert.equal((await board.getBoardConfig()).token, TOKEN);
});

test('other credential-shaped parameters are stripped, not adopted', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { h, board } = await setup(t);
  await board.updateBoardSettings({ baseUrl: `${BASE}?key=${TOKEN}&secret=${TOKEN}&sheet=today` });
  const row = await h.query('SELECT base_url FROM dispatch_board_settings WHERE id = 1');
  assert.ok(!row.rows[0].base_url.includes(TOKEN), row.rows[0].base_url);
  assert.match(row.rows[0].base_url, /sheet=today/, 'an ordinary parameter survives');
});

test('a database failure is not reported as "not configured"', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { h, board } = await setup(t);
  await board.updateBoardSettings({ baseUrl: BASE, token: TOKEN });
  board.invalidateCache();
  await h.query('DROP TABLE dispatch_board_settings');

  // An outage and an erased configuration are opposite facts. Answering 200
  // with "off and unconfigured" — and caching it for 30 seconds — makes them
  // the same on screen (APP_BRIEF §9: a failure is never rendered as empty
  // data). The route turns this into a 500; it must not be swallowed here.
  await assert.rejects(() => board.getBoardConfig(), /dispatch_board_settings|relation/i);
});
