'use strict';

/**
 * The admin build sets its own heap limit.
 *
 * Render applies the service's NODE_OPTIONS (--max-old-space-size=256, meant
 * for the running server) to the BUILD as well. Once three.js joined the
 * bundle for the race's 4 PM celebration (#277), `vite build` needed more
 * than that and died with "JavaScript heap out of memory" (exit 134). Every
 * deploy then failed silently and production stayed on the previous build.
 *
 * A heap flag on the command line beats NODE_OPTIONS, so the build script
 * carries one. Locally the build fails under a 200 MB cap and passes at 256,
 * so 512 leaves room for the bundle to grow.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const adminPackage = require(path.join(__dirname, '..', 'admin', 'package.json'));

test('the admin build runs vite with its own heap limit, not the server cap', () => {
  const build = adminPackage.scripts.build;
  const match = /^node --max-old-space-size=(\d+) node_modules\/vite\/bin\/vite\.js build$/.exec(build);
  assert.ok(match, `admin build script must set a heap limit on the command line, got: ${build}`);
  assert.ok(Number(match[1]) >= 384, `a heap limit of ${match[1]} MB is too close to the cap that broke the build`);
});
