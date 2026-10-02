/**
 * Following a Telegram group to its new id — the pure half, the delivery
 * paths, and the guard that keeps the list of destinations complete.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  DESTINATION_SETTINGS, DESTINATION_MAPS, normaliseChatId, migrationTargetFrom, rewriteChatMap, describeMigration,
} = require('../lib/telegram/chatMigration');
const { probeOnce } = require('../services/telegramDestinationProbe');

const { upgradedError } = require('./helpers/telegramErrors');

test('the new id is read out of the error Telegram returns', () => {
  assert.equal(migrationTargetFrom(upgradedError()), '-1001234567890');
  assert.equal(migrationTargetFrom({ parameters: { migrate_to_chat_id: -1009 * 1000 } }), '-1009000');
  assert.equal(migrationTargetFrom(new Error('400: Bad Request: chat not found')), null, 'not a move');
  assert.equal(migrationTargetFrom(null), null);
});

test('a chat id is a canonical integer string or nothing', () => {
  assert.equal(normaliseChatId(-5052301861), '-5052301861');
  assert.equal(normaliseChatId(' -1001234567890 '), '-1001234567890');
  assert.equal(normaliseChatId('chat'), null);
  assert.equal(normaliseChatId(''), null);
});

test('a routing map moves only the values naming the old chat', () => {
  const out = rewriteChatMap({ fuel: '-111111', finance: -222222, safety: '-111111' }, '-111111', '-100999');
  assert.equal(out.changed, 2);
  assert.deepEqual(out.map, { fuel: '-100999', finance: -222222, safety: '-100999' });
});

test('the owner is told in words, without an id', () => {
  const lines = describeMigration({ from: '-5052301861', to: '-1001234567890', changed: [{ rows: 2 }, { rows: 1 }], requeued: 4 });
  const text = lines.join(' ');
  assert.match(text, /moved 3 setting\(s\)/);
  assert.match(text, /4 notice\(s\) from the last 48 hours/);
  assert.doesNotMatch(text, /5052301861|1234567890/);
});

// ── the guard: every chat column in a settings table is accounted for ────────

// A settings column that names a chat but must NOT move with a group goes
// here, with the reason. None does today: the scan finds twelve columns and all
// twelve are destinations.
const NOT_DESTINATIONS = Object.freeze({});

test('every chat-id column in a *_settings table is a destination or has a stated reason not to be', () => {
  const dir = path.join(__dirname, '..', 'database');
  const sql = ['baseline', 'migrations']
    .flatMap((d) => fs.readdirSync(path.join(dir, d)).filter((f) => f.endsWith('.sql')).map((f) => path.join(dir, d, f)))
    .map((f) => fs.readFileSync(f, 'utf8').replace(/--[^\n]*/g, ''))
    .join('\n');
  const found = new Set();
  for (const m of sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w*settings)\s*\(([\s\S]*?)\n\);/g)) {
    for (const line of m[2].split('\n')) {
      const c = line.match(/^\s*(\w*(?:chat_id|chat_ids|group_id))\s+(TEXT|BIGINT|JSONB)/i);
      if (c) found.add(`${m[1]}.${c[1]}`);
    }
  }
  for (const m of sql.matchAll(/ALTER TABLE (?:IF EXISTS )?(\w*settings)\s+ADD COLUMN IF NOT EXISTS (\w*(?:chat_id|chat_ids|group_id))\s+(TEXT|BIGINT|JSONB)/gi)) {
    found.add(`${m[1]}.${m[2]}`);
  }
  const known = new Set([...DESTINATION_SETTINGS, ...DESTINATION_MAPS].map((s) => `${s.table}.${s.column}`));
  const missing = [...found].filter((k) => !known.has(k) && !NOT_DESTINATIONS[k]);
  assert.deepEqual(missing, [],
    'a settings column naming a chat is neither followed on a group move nor explained — add it to '
    + 'lib/telegram/chatMigration.js or to NOT_DESTINATIONS with the reason');
  assert.ok(found.size >= 12, `the scan found only ${found.size} columns — it is not reading the schema`);
});

// ── the probe ───────────────────────────────────────────────────────────────

test('the probe follows a moved group and leaves an unreachable one alone', async () => {
  const followed = [];
  const said = [];
  const telegram = {
    async getChat(id) {
      if (id === '-5052301861') throw upgradedError(-1007777777777);
      if (id === '-4000000000') throw Object.assign(new Error('400: Bad Request: chat not found'), { response: { error_code: 400 } });
      return { id };
    },
  };
  const out = await probeOnce({
    telegram,
    deps: {
      store: { async listDestinationChatIds() { return ['-5052301861', '-4000000000', '-1001111111111']; } },
      migration: {
        async followMigrationFromError(err, id) {
          const to = migrationTargetFrom(err);
          if (!to) return null;
          followed.push([id, to]);
          return { newChatId: to, summary: { from: id, to, changed: [{ rows: 1 }], requeued: 0, nothingToDo: false } };
        },
        migrationNotice: (s) => ({ category: 'self_healing', title: 't', lines: describeMigration(s) }),
      },
      notify: async (n) => { said.push(n); },
    },
  });
  assert.equal(out.checked, 3);
  assert.equal(out.moved, 1);
  assert.equal(out.unreachable, 1);
  assert.equal(out.followFailed, 0);
  assert.equal(out.reasons, '400: Bad Request: chat not found (x1)', 'Telegram\'s words, no id');
  assert.equal(out.error, undefined);
  assert.deepEqual(followed, [['-5052301861', '-1007777777777']]);
  await new Promise((r) => setImmediate(r));
  assert.equal(said.length, 1, 'the owner is told once');
});

function migrationDeps({ applied = true } = {}) {
  const followed = [];
  return {
    followed,
    store: { async listDestinationChatIds() { return ['-5052301861']; } },
    migration: {
      async followMigrationFromError(err, id) {
        const to = migrationTargetFrom(err);
        if (!to) return null;
        followed.push([id, to]);
        return { newChatId: to, summary: applied ? { from: id, to, changed: [{ rows: 1 }], requeued: 0, nothingToDo: false } : null };
      },
      migrationNotice: () => null,
    },
    notify: async () => {},
  };
}

test('when reading refuses WITHOUT naming the new id, a write is tried — and its error does', async () => {
  // The first production pass asked every destination and followed nothing,
  // while every real send to the managers' chat still failed with the move.
  const actions = [];
  const telegram = {
    async getChat() { throw Object.assign(new Error('400: Bad Request: chat not found'), { response: { error_code: 400 } }); },
    async sendChatAction(id, action) { actions.push([id, action]); throw upgradedError(-1007777777777); },
  };
  const d = migrationDeps();
  const out = await probeOnce({ telegram, deps: d });
  assert.deepEqual(actions, [['-5052301861', 'typing']]);
  assert.deepEqual(d.followed, [['-5052301861', '-1007777777777']]);
  assert.equal(out.moved, 1);
  assert.equal(out.unreachable, 0);
});

test('a healthy chat is only READ — nothing appears in it', async () => {
  const actions = [];
  const telegram = { async getChat(id) { return { id }; }, async sendChatAction(...a) { actions.push(a); } };
  const out = await probeOnce({ telegram, deps: migrationDeps() });
  assert.deepEqual(actions, [], 'no "typing…" in a working staff chat');
  assert.equal(out.checked, 1);
  assert.equal(out.moved, 0);
});

test('a move found but not applied is an ERROR, never a quiet clean run', async () => {
  const telegram = { async getChat() { throw upgradedError(-1007777777777); } };
  const out = await probeOnce({ telegram, deps: migrationDeps({ applied: false }) });
  assert.equal(out.followFailed, 1);
  assert.equal(out.moved, 0);
  assert.match(out.error, /could not be applied/);
});

test('the probe without a Telegram client stands down as blocked, not failed', async () => {
  assert.deepEqual(await probeOnce({ telegram: null }), { blocked: 'no Telegram client to ask' });
});


test('the probe\'s reasons survive the run ledger — it keeps only flat values', async () => {
  // database/backgroundRuns.js safeSummary drops every object-valued field; a
  // reasons MAP would vanish and /api/health would show none exactly when it
  // matters. Run the real sanitiser over a real probe summary.
  const { safeSummary } = require('../database/backgroundRuns');
  const telegram = {
    async getChat() { throw Object.assign(new Error('403: Forbidden: bot was kicked from the group chat'), { response: { error_code: 403 } }); },
  };
  const out = await probeOnce({ telegram, deps: migrationDeps() });
  const stored = safeSummary(out);
  assert.equal(stored.reasons, '403: Forbidden: bot was kicked from the group chat (x1)');
  assert.equal(stored.unreachable, 1);
});
