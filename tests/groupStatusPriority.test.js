const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dbSrc = fs.readFileSync(
  path.join(__dirname, '../database/db.js'),
  'utf8'
);

test('deactivateGroup sets bot source and inactive', () => {
  const fn = dbSrc.match(
    /async function deactivateGroup[\s\S]*?`([\s\S]*?)`/
  );
  assert.ok(fn);
  const sql = fn[1];
  assert.match(sql, /active\s*=\s*FALSE/i);
  assert.match(sql, /status_source\s*=\s*'bot'/i);
});

test('reactivateGroupOnBotJoin sets provisional bot active', () => {
  const fn = dbSrc.match(
    /async function reactivateGroupOnBotJoin[\s\S]*?`([\s\S]*?)`/
  );
  assert.ok(fn);
  const sql = fn[1];
  assert.match(sql, /active\s*=\s*TRUE/i);
  assert.match(sql, /status_source\s*=\s*'bot'/i);
});

test('setGroupStatusByAdmin uses manual source', () => {
  assert.match(dbSrc, /async function setGroupStatusByAdmin[\s\S]*?'manual'/);
});

test('getDriverGroupsForStatusAi excludes manual locks', () => {
  const fn = dbSrc.match(
    /async function getDriverGroupsForStatusAi[\s\S]*?`([\s\S]*?)`/
  );
  assert.ok(fn);
  const sql = fn[1];
  assert.match(sql, /status_source IS DISTINCT FROM 'manual'/i);
});
