'use strict';

/**
 * The admin panel's HTTP plumbing has one home: admin/src/api/http.js.
 *
 * Settings → Reactions' client used to sit outside api/ as
 * admin/src/autoReactionsApi.js with its own copy of the bearer-token headers
 * and the error unwrapping, "kept separate from the large api.js so that
 * baselined file does not grow". api.js has long been a façade over domain
 * modules, so the copy only meant its errors skipped what handleApiError adds
 * (status, code, an HTML body classified for pageFailure.js). The audit's
 * block 5 moved it to admin/src/api/autoReactions.js; this keeps every client
 * on the one funnel.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function adminSources(dir = 'admin/src', out = []) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) adminSources(rel, out);
    else if (/\.(js|jsx|mjs)$/.test(entry.name) && !/\.test\.jsx?$/.test(entry.name)) out.push(rel);
  }
  return out;
}

test('only admin/src/api/http.js defines the headers and the error funnel', () => {
  const copies = adminSources()
    .filter((rel) => rel !== 'admin/src/api/http.js')
    .filter((rel) => /function (getHeaders|handleError|handleApiError)\s*\(/.test(read(rel)));
  assert.deepEqual(copies, []);
});

test('the reactions client is a domain module the façade forwards', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'admin/src/autoReactionsApi.js')), false);
  assert.match(read('admin/src/api/autoReactions.js'), /from '\.\/http'/);
  assert.match(read('admin/src/api.js'), /export \* from '\.\/api\/autoReactions';/);
});
