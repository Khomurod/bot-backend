'use strict';

/**
 * Settings → Safety Approvals, the HTTP layer. The rules worth pinning: the
 * feature cannot be switched on without a validated group, a topic and a
 * Safety person; a topic link from another group is refused; the group is
 * taken out of the driver features on save; and a bot that cannot see the
 * group's messages is reported. The database and Telegram are stubbed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://localhost:5432/unused_in_this_test';

const ROOT = path.resolve(__dirname, '..');
function stub(rel, exports) {
  const filename = require.resolve(path.resolve(ROOT, rel));
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

let row;
let statements;
stub('database/pool.js', {
  pool: {},
  query: async (text, values) => {
    statements.push(text);
    if (/UPDATE safety_approval_settings/.test(text)) {
      row = {
        ...row, enabled: values[0], chat_id: values[1], chat_title: values[2], chat_validated_at: values[3],
        topic_id: values[4], safety_user_ids: values[5], enabled_at: values[6],
      };
      return { rows: [row] };
    }
    if (/FROM safety_approval_settings/.test(text)) return { rows: [row] };
    if (/UPDATE groups SET group_type = 'recruitment'/.test(text)) return { rowCount: 1 };
    return { rows: [] };
  },
});
stub('database/groups.js', { getGroupByTelegramId: async (id) => (String(id) === '-100777' ? { id: 3, group_name: 'Recruiting' } : undefined) });
stub('database/groupMembers.js', {
  listGroupMembers: async () => [{ telegram_user_id: '900', first_name: 'Avery', last_name: 'Davis', username: null }],
});
stub('database/safetyApprovals/reviews.js', { listRecentReviews: async () => [] });

const { createSafetyApprovalSettingsRouter } = require('../server/routes/settings/safetyApprovalRoutes');
const settingsStore = require('../database/safetyApprovals/settings');

let seesAll = true;
const sent = [];
const telegram = {
  getChat: async () => ({ type: 'supergroup', title: 'Recruiting' }),
  getMe: async () => ({ id: 1, can_read_all_group_messages: seesAll }),
  getChatMember: async () => ({ status: 'member' }),
  sendMessage: async (...args) => { sent.push(args); return { message_id: 1 }; },
};

async function withServer(fn) {
  statements = [];
  settingsStore.invalidateCache();
  const app = express();
  app.use(express.json());
  app.use('/s', createSafetyApprovalSettingsRouter({
    authMiddleware: (req, res, next) => { req.admin = { id: 5 }; next(); }, telegram,
  }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}/s/safety-approvals`);
  } finally {
    server.close();
  }
}
const J = { 'Content-Type': 'application/json' };
const put = (url, body) => fetch(url, { method: 'PUT', headers: J, body: JSON.stringify(body) });

function freshRow() {
  row = {
    id: 1, enabled: false, chat_id: null, chat_title: null, chat_validated_at: null,
    topic_id: null, safety_user_ids: [], enabled_at: null, updated_at: null,
  };
}

test('it cannot be switched on until group, topic and Safety are all saved', async () => {
  freshRow();
  await withServer(async (base) => {
    let res = await put(base, { enabled: true });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /validate the recruiting group.*topic.*Safety person/);

    res = await put(base, { chatId: '-100777' });
    assert.equal(res.status, 200);
    assert.ok(statements.some((s) => /group_type = 'recruitment'/.test(s)), 'the group leaves the driver features');

    res = await put(base, { topic: 'https://t.me/c/777/45/1200', safetyUserIds: ['900', 'x'] });
    const saved = await res.json();
    assert.equal(saved.topicId, 45);
    assert.deepEqual(saved.safetyUserIds, ['900']);

    res = await put(base, { enabled: true });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).enabled, true);
  });
});

test('a topic link from another group is refused', async () => {
  freshRow();
  await withServer(async (base) => {
    await put(base, { chatId: '-100777' });
    const res = await put(base, { topic: 'https://t.me/c/999/45' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /different group/);
  });
});

test('validation reports a bot that cannot see the group\'s messages', async () => {
  freshRow();
  seesAll = false;
  await withServer(async (base) => {
    const res = await fetch(`${base}/validate-chat`, { method: 'POST', headers: J, body: JSON.stringify({ chatId: '-100777' }) });
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.seesEverything, false);
    assert.match(body.message, /admin/);
  });
  seesAll = true;
});

test('GET lists the people seen in the group for the Safety picker', async () => {
  freshRow();
  row.chat_id = '-100777';
  await withServer(async (base) => {
    const body = await (await fetch(base)).json();
    assert.deepEqual(body.members.map((m) => [m.id, m.name]), [['900', 'Avery Davis']]);
  });
});

test('the test message goes to the topic', async () => {
  freshRow();
  Object.assign(row, { chat_id: '-100777', topic_id: 45 });
  await withServer(async (base) => {
    const body = await (await fetch(`${base}/test-post`, { method: 'POST' })).json();
    assert.equal(body.ok, true);
    assert.equal(sent.at(-1)[0], '-100777');
    assert.deepEqual(sent.at(-1)[2], { message_thread_id: 45 });
  });
});
