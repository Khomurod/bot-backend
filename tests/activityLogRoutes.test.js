'use strict';

/**
 * GET /api/activity-log — Monitoring → Logs. SUPER ADMINISTRATORS ONLY, by
 * role (the owner's decision); filters checked before they reach SQL; a link
 * built from the portal's origin only, never the webhook URL.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createActivityLogRouter } = require('../server/routes/activityLogRoutes');
const admin = require('../services/activityLog/admin');

function app(roleKeys, activityLog) {
  const a = express();
  const authMiddleware = (req, res, next) => { req.admin = { id: 1, role_keys: roleKeys }; next(); };
  a.use('/api/activity-log', createActivityLogRouter({ authMiddleware, activityLog }));
  return a;
}

async function get(a, url) {
  const server = a.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`);
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

const page = {
  entries: [{
    id: 1, system: 'bitrix', targetType: 'deal', targetId: '321', result: 'done',
  }],
  nextCursor: null,
};

test('only a super administrator may read the logs', async () => {
  const fake = { listActivity: async () => page };
  const ok = await get(app(['super_admin'], fake), '/api/activity-log');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.entries.length, 1);
  const no = await get(app(['admin'], fake), '/api/activity-log');
  assert.equal(no.status, 403);
  assert.equal(no.body.entries, undefined);
});

test('a bad filter is a 400; a failure says nothing about why', async () => {
  const real = await get(app(['super_admin'], admin), '/api/activity-log?result=maybe');
  assert.equal(real.status, 400);
  const broken = await get(app(['super_admin'], {
    listActivity: async () => { throw new Error('connect ECONNREFUSED postgres://u:p@h/db'); },
  }), '/api/activity-log');
  assert.equal(broken.status, 500);
  assert.doesNotMatch(JSON.stringify(broken.body), /postgres|ECONNREFUSED/);
});

test('filters are checked, and the list carries links from the origin only', async () => {
  assert.throws(() => admin.readFilters({ from: 'yesterday' }), admin.FilterError);
  assert.throws(() => admin.readFilters({ trigger: 'x; DROP TABLE' }), admin.FilterError);
  assert.throws(() => admin.readFilters({ before: 'abc' }), admin.FilterError);
  const f = admin.readFilters({
    from: '2026-11-01T05:00:00.000Z', trigger: 'board_bitrix.sync', result: 'refused', search: '  Ann  ', before: '2026-11-13 10:00:00.123456+00~42',
  });
  assert.equal(f.search, 'Ann');
  assert.equal(f.result, 'refused');

  let asked = null;
  const out = await admin.listActivity({ search: '321' }, {
    store: { PAGE_SIZE: 50, listEntries: async (filters) => { asked = filters; return page; } },
    portalOrigin: async () => 'https://acme.bitrix24.com',
  });
  assert.equal(asked.search, '321');
  assert.equal(out.entries[0].link, 'https://acme.bitrix24.com/crm/deal/details/321/');
  assert.ok(out.triggers.some((t) => t.key === 'hiring_stage.move'));
  assert.equal(admin.linkFor(null, page.entries[0]), null);
});
