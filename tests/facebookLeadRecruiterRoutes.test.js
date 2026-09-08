/**
 * The Facebook Leads → Auto-Reply Setup HTTP surface, recruiter section.
 *
 * What is being guarded:
 *   • the section is driven by the `recruiters` table, so a recruiter hired
 *     later appears with an empty box and no code change;
 *   • a payload with no `recruiter_messages` key leaves every template alone —
 *     an older admin bundle must not silently wipe them;
 *   • a blank template is a valid way to REMOVE an override, while an unknown
 *     placeholder is refused before it can reach a driver;
 *   • the recruiter section failing to load never takes the page down with it.
 *
 * The data layer is stubbed at the pool seam, like the other route suites.
 */
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.JWT_SECRET ||= 'test-secret';
process.env.BOT_TOKEN ||= '123:test-bot-token';
process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY ||= 'test-encryption-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

const { purgeDataLayer, POOL_PATH } = require('./helpers/purgeDataLayer');

const ROUTE_PATH = path.resolve(__dirname, '../server/routes/facebookLeadsRoutes.js');
const WEBHOOK_PATH = path.resolve(__dirname, '../services/facebookWebhookService.js');

const SETTINGS = {
  id: 1,
  timezone: 'America/Chicago',
  is_enabled: true,
  rep_name: 'Tom',
  company_name: 'Wenze trucking company',
  position_label: 'OTR position',
  fallback_template: 'Hello {first_name}, this is {rep_name}.',
};

const RULES = [{
  id: 5, settings_id: 1, label: 'Working hours', days_of_week: [1, 2, 3, 4, 5],
  start_time_local: '08:00', end_time_local: '17:00',
  message_template: 'Hi {first_name}, {rep_name} here.', sort_order: 0, is_active: true,
}];

const RECRUITER_ROWS = [
  { recruiter_id: 11, recruiter_name: 'Sofia', recruiter_active: true, bitrix_user_id: 21, message_template: 'Sofia here.', is_enabled: true, updated_at: null },
  { recruiter_id: 12, recruiter_name: 'Kimberly', recruiter_active: true, bitrix_user_id: 22, message_template: null, is_enabled: true, updated_at: null },
  { recruiter_id: 13, recruiter_name: 'Jaime', recruiter_active: true, bitrix_user_id: null, message_template: null, is_enabled: true, updated_at: null },
];

/**
 * The database/pool stub. It must expose BOTH `query` and `pool` — the data
 * layer destructures `{ pool, query }`, and the transactional writers use
 * `pool.connect()`.
 */
function makePool({ recruiterRows = RECRUITER_ROWS, recruiterListThrows = null } = {}) {
  const writes = [];
  const connect = async () => ({
      query: async (sql, params = []) => {
        const flat = sql.replace(/\s+/g, ' ').trim();
        if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(flat)) return { rows: [] };
        writes.push({ sql: flat, params });
        if (/facebook_lead_auto_message_settings/i.test(flat) && /^SELECT/i.test(flat)) return { rows: [SETTINGS] };
        if (/^INSERT INTO facebook_lead_auto_message_rules/i.test(flat)) return { rows: [RULES[0]] };
        return { rows: [] };
      },
      release: () => {},
  });
  const query = async (sql, params = []) => {
      const flat = sql.replace(/\s+/g, ' ').trim();
      if (/FROM facebook_lead_auto_message_settings/i.test(flat)) return { rows: [SETTINGS] };
      if (/FROM facebook_lead_auto_message_rules/i.test(flat)) return { rows: RULES };
      if (/FROM recruiters r LEFT JOIN facebook_lead_recruiter_messages/i.test(flat)) {
        if (recruiterListThrows) throw recruiterListThrows;
        return { rows: recruiterRows };
      }
      writes.push({ sql: flat, params });
      return { rows: [] };
  };
  return { writes, connect, query, pool: { connect, query } };
}

function loadApp(pool) {
  require.cache[POOL_PATH] = { id: POOL_PATH, filename: POOL_PATH, loaded: true, exports: pool };
  purgeDataLayer([ROUTE_PATH, WEBHOOK_PATH]);
  require.cache[WEBHOOK_PATH] = {
    exports: { retryFacebookWebhookEvent: async () => null, getFacebookWebhookLog: async () => [] },
  };
  const { createFacebookLeadsRouter } = require(ROUTE_PATH);
  const app = express();
  app.use(express.json());
  app.use('/api/facebook-leads', createFacebookLeadsRouter({
    authMiddleware: (req, _res, next) => { req.admin = { username: 'admin' }; next(); },
  }));
  return app;
}

async function call(app, method, pathname, body) {
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const cleanup = (t) => t.after(() => {
  purgeDataLayer([ROUTE_PATH, WEBHOOK_PATH]);
  delete require.cache[POOL_PATH];
});

test('every active recruiter is listed, template or not', async (t) => {
  cleanup(t);
  const app = loadApp(makePool());
  const res = await call(app, 'GET', '/api/facebook-leads/auto-messages');

  assert.equal(res.status, 200);
  assert.deepEqual(
    res.json.recruiter_messages.map((r) => r.recruiter_name),
    ['Sofia', 'Kimberly', 'Jaime'],
  );
  assert.equal(res.json.recruiter_messages[0].message_template, 'Sofia here.');
  assert.equal(res.json.recruiter_messages[1].message_template, '', 'no override reads as empty, not null');
  assert.equal(res.json.recruiter_messages[2].bitrix_user_id, null, 'so the panel can warn they can never be assigned');
});

test('the recruiter section failing does not take the page down', async (t) => {
  cleanup(t);
  const app = loadApp(makePool({ recruiterListThrows: new Error('relation does not exist') }));
  const res = await call(app, 'GET', '/api/facebook-leads/auto-messages');

  assert.equal(res.status, 200, 'the global rules still load and can still be saved');
  assert.deepEqual(res.json.recruiter_messages, []);
  assert.ok(res.json.settings);
});

test('an unknown placeholder in a recruiter template is refused, naming who', async (t) => {
  cleanup(t);
  const app = loadApp(makePool());
  const res = await call(app, 'PUT', '/api/facebook-leads/auto-messages', {
    settings: SETTINGS,
    rules: RULES,
    recruiter_messages: [
      { recruiter_id: 11, recruiter_name: 'Sofia', message_template: 'Hi {first_name} {dispatcher}' },
    ],
  });

  assert.equal(res.status, 400);
  assert.match(res.json.details.join(' '), /Sofia/);
  assert.match(res.json.details.join(' '), /dispatcher/);
});

test('a blank template is accepted — it is how an override is removed', async (t) => {
  cleanup(t);
  const pool = makePool();
  const app = loadApp(pool);
  const res = await call(app, 'PUT', '/api/facebook-leads/auto-messages', {
    settings: SETTINGS,
    rules: RULES,
    recruiter_messages: [{ recruiter_id: 11, recruiter_name: 'Sofia', message_template: '   ' }],
  });

  assert.equal(res.status, 200);
  assert.ok(
    pool.writes.some((w) => /DELETE FROM facebook_lead_recruiter_messages/i.test(w.sql)),
    'blank deletes the row rather than storing an empty string',
  );
});

test('a payload with no recruiter section leaves every template alone', async (t) => {
  cleanup(t);
  const pool = makePool();
  const app = loadApp(pool);
  const res = await call(app, 'PUT', '/api/facebook-leads/auto-messages', {
    settings: SETTINGS,
    rules: RULES,
  });

  assert.equal(res.status, 200);
  assert.equal(
    pool.writes.some((w) => /facebook_lead_recruiter_messages/i.test(w.sql) && !/^SELECT/i.test(w.sql)),
    false,
    'an older admin bundle must not silently wipe the recruiter templates',
  );
  assert.equal(res.json.recruiter_messages.length, 3, 'they are still reported back');
});
