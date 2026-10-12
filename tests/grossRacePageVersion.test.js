'use strict';

/**
 * Which build of the race page the server hands out (services/grossRace/
 * pageVersion.js). A screen reloads when it runs another one, so the answer
 * must be the one chunk the build holds, and null whenever there is any doubt:
 * null never reloads a screen.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRacePageVersion, racePageChunk } = require('../services/grossRace/pageVersion');

test('the race page chunk is picked out of a build listing', () => {
  assert.equal(
    racePageChunk(['index-WcpchOU9.js', 'GrossRacePage-DBGbqg8F.js', 'GrossRacePage-B1x2.css', 'three.module-DVI_j9-M.js']),
    'GrossRacePage-DBGbqg8F.js',
  );
});

test('no build, or a doubtful one, names nothing', () => {
  assert.equal(racePageChunk([]), null);
  assert.equal(racePageChunk(undefined), null);
  assert.equal(racePageChunk(['GrossRacePage-B1x2.css']), null, 'the stylesheet is not the page');
  assert.equal(racePageChunk(['GrossRacePage-aaaa.js', 'GrossRacePage-bbbb.js']), null, 'two builds side by side');
  assert.equal(racePageChunk(['GrossRacePage.jsx', 'MyGrossRacePage-aaaa.js']), null);
});

test('the build is read once, when first asked', () => {
  let reads = 0;
  const version = createRacePageVersion({
    assetsDir: '/build/assets',
    readdir: (dir) => { reads += 1; assert.equal(dir, '/build/assets'); return ['GrossRacePage-aaaa.js']; },
  });
  assert.equal(reads, 0, 'nothing is read at start-up');
  assert.equal(version(), 'GrossRacePage-aaaa.js');
  assert.equal(version(), 'GrossRacePage-aaaa.js');
  assert.equal(reads, 1);
});

test('a missing build is null, not an error', () => {
  const version = createRacePageVersion({ assetsDir: path.join(os.tmpdir(), 'no-such-admin-build', 'assets') });
  assert.equal(version(), null);
});

test('it reads a real directory', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'race-page-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of ['index-aaaa.js', 'GrossRacePage-Zz_9-x.js']) fs.writeFileSync(path.join(dir, name), '');
  assert.equal(createRacePageVersion({ assetsDir: dir })(), 'GrossRacePage-Zz_9-x.js');
});
