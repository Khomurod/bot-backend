/**
 * HTTP-layer tests for /api/settings/retired-leftovers.
 *
 * This is the only route in the application that can drop a table, so the
 * tests are mostly about refusals: no admin token, no confirmation phrase, a
 * group key that is not on the hard-coded list, and — the one that matters
 * most — a request that tries to name a table directly. In every case the
 * database layer must not be reached at all, which is why the stub below
 * records whether it was called.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET ||= 'test-secret';
process.env.BOT_TOKEN ||= '000:testbot';
process.env.TELEGRAM_BOT_TOKEN ||= '000:testnotif';
process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.DATABASE_URL ||= 'postgresql://localhost:5432/unused_in_this_test';

const ROOT = path.resolve(__dirname, '..');
const R = (rel) => path.resolve(ROOT, rel);
function stub(rel, exports) {
  const filename = require.resolve(R(rel));
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

// The real module's hard-coded lists are the security property, so they are
// kept; only the two functions that touch the database are replaced, and each
// records that it ran so a test can assert it did NOT.
const real = require(R('database/retiredLeftovers'));
const calls = { inventory: 0, purge: 0, drop: [] };
stub('database/retiredLeftovers.js', {
  ...real,
  getLeftoverInventory: async () => {
    calls.inventory += 1;
    return {
      groups: [{
        key: 'trailer', label: 'Trailer Department and Trailer Tracking',
        removed_at: '2026-09', note: 'n', tables: [], tables_present: 0, total_rows: 0,
      }],
      rbac: { roles: [], permissions: [], accounts: [] },
    };
  },
  purgeRetiredRbac: async () => {
    calls.purge += 1;
    return { deactivated_accounts: [], deleted_roles: [], deleted_permissions: [] };
  },
  dropRetiredTables: async ({ groupKeys }) => {
    calls.drop.push(groupKeys);
    return { groups: groupKeys, dropped: [], already_absent: [], blocked: [] };
  },
});

const { createSettingsRouter } = require(R('server/routes/settingsRoutes'));
const { DROP_CONFIRMATION_PHRASE } = require(R('server/routes/settings/retiredLeftoversRoutes'));

function makeServer({ auth = 'ok' } = {}) {
  const app = express();
  app.use(express.json());
  const authMiddleware = auth === 'ok'
    ? (req, res, next) => { req.admin = { id: 7, username: 'tester' }; next(); }
    : (req, res) => res.status(401).json({ error: 'Unauthorized' });
  app.use('/api/settings', createSettingsRouter({ authMiddleware, telegram: null }));
  return http.createServer(app);
}

async function withServer(opts, fn) {
  const server = makeServer(opts);
  await new Promise((r) => server.listen(0, r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}/api/settings`);
  } finally {
    server.close();
  }
}
const J = { 'Content-Type': 'application/json' };

test('GET returns the inventory and the confirmation phrase the UI must show', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/retired-leftovers`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.confirmation_phrase, DROP_CONFIRMATION_PHRASE);
    assert.equal(body.groups[0].key, 'trailer');
  });
});

test('every route requires an admin token', async () => {
  await withServer({ auth: 'deny' }, async (base) => {
    assert.equal((await fetch(`${base}/retired-leftovers`)).status, 401);
    assert.equal((await fetch(`${base}/retired-leftovers/purge-config`, { method: 'POST' })).status, 401);
    const drop = await fetch(`${base}/retired-leftovers/drop-tables`, {
      method: 'POST', headers: J,
      body: JSON.stringify({ groups: ['trailer'], confirm: DROP_CONFIRMATION_PHRASE }),
    });
    assert.equal(drop.status, 401);
  });
});

test('a drop without the exact confirmation phrase is refused before any SQL', async () => {
  await withServer({}, async (base) => {
    const before = calls.drop.length;
    for (const confirm of [undefined, '', 'yes', 'delete', DROP_CONFIRMATION_PHRASE.toLowerCase(), `${DROP_CONFIRMATION_PHRASE} `]) {
      const res = await fetch(`${base}/retired-leftovers/drop-tables`, {
        method: 'POST', headers: J, body: JSON.stringify({ groups: ['trailer'], confirm }),
      });
      assert.equal(res.status, 400, `confirm=${JSON.stringify(confirm)} must be refused`);
      assert.equal((await res.json()).code, 'CONFIRMATION_REQUIRED');
    }
    assert.equal(calls.drop.length, before, 'the database layer must not be reached');
  });
});

test('a table name cannot be smuggled in where a group key belongs', async () => {
  await withServer({}, async (base) => {
    const before = calls.drop.length;
    for (const groups of [['admins'], ['groups'], ['trailers'], ['trailer', 'drivers'], ['public.admins'], ['admins; DROP TABLE groups']]) {
      const res = await fetch(`${base}/retired-leftovers/drop-tables`, {
        method: 'POST', headers: J,
        body: JSON.stringify({ groups, confirm: DROP_CONFIRMATION_PHRASE }),
      });
      assert.equal(res.status, 400, `${JSON.stringify(groups)} must be refused`);
      assert.match((await res.json()).error, /Unknown leftover group/);
    }
    assert.equal(calls.drop.length, before, 'the database layer must not be reached');
  });
});

test('an empty group selection is refused', async () => {
  await withServer({}, async (base) => {
    for (const groups of [[], undefined, null, 'trailer']) {
      const res = await fetch(`${base}/retired-leftovers/drop-tables`, {
        method: 'POST', headers: J,
        body: JSON.stringify({ groups, confirm: DROP_CONFIRMATION_PHRASE }),
      });
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, /Select at least one group/);
    }
  });
});

test('a valid drop reaches the database layer with de-duplicated known keys only', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/retired-leftovers/drop-tables`, {
      method: 'POST', headers: J,
      body: JSON.stringify({ groups: ['trailer', 'trailer', 'qbq_sos'], confirm: DROP_CONFIRMATION_PHRASE }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(calls.drop.at(-1), ['trailer', 'qbq_sos']);
  });
});

test('the config purge needs no phrase — it is reversible bookkeeping', async () => {
  await withServer({}, async (base) => {
    const before = calls.purge;
    const res = await fetch(`${base}/retired-leftovers/purge-config`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(calls.purge, before + 1);
  });
});
