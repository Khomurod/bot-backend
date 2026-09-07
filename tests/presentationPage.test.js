'use strict';

/**
 * The public product page (`GET /presentation`) — static guards.
 *
 * The page was one 1 320-line self-contained document until it passed the
 * repository's 500-line limit. It is now a document plus a stylesheet and
 * three scripts that must load in dependency order, which creates two new ways
 * to break it that no build step would catch: a script that references a
 * binding another file forgot to export, and an asset the page references but
 * the route does not serve.
 *
 * The third test is the one that has already earned its place. FRAGS and AFTER
 * in the convergence scene are index-matched arrays, one entry per fragment
 * tile. Removing the Trailers capability from AFTER without removing its
 * partner left an 8-tile DOM reading AFTER[7], and the page threw
 * `Cannot read properties of undefined` on every scroll past that section —
 * silently, in a marketing page nobody has open in a console.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.resolve(__dirname, '..', 'server', 'presentation');
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');

const html = read('index.html');
const engine = read('presentation-engine.js');
const scroll = read('presentation-scroll.js');
const scenes = read('presentation-scenes.js');

function countEntries(source, name) {
  const match = new RegExp(`var ${name}=\\[([\\s\\S]*?)\\n\\];`).exec(source);
  assert.ok(match, `${name} must still be an array literal`);
  return (match[1].match(/\{en:/g) || []).length;
}

test('the page loads its assets in dependency order', () => {
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(scripts, [
    '/presentation/presentation-engine.js',
    '/presentation/presentation-scroll.js',
    '/presentation/presentation-scenes.js',
  ], 'the engine must load before the framework, and both before the scenes');
  assert.match(html, /<link rel="stylesheet" href="\/presentation\/presentation\.css">/);
});

test('every asset the page references is served by the route', () => {
  const routes = read(path.join('..', 'routes', 'healthRoutes.js'));
  const refs = [
    ...html.matchAll(/<script[^>]+src="(\/presentation\/[^"]+)"/g),
    ...html.matchAll(/<link[^>]+href="(\/presentation\/[^"]+)"/g),
  ].map((m) => m[1]);
  assert.ok(refs.length >= 4, 'the page must reference its stylesheet and three scripts');
  for (const ref of refs) {
    assert.ok(routes.includes(`'${ref}'`), `${ref} must be in the presentation asset allow-list`);
    assert.ok(fs.existsSync(path.join(DIR, path.basename(ref))), `${ref} must exist on disk`);
  }
});

test('FRAGS and AFTER stay index-matched, and the tile count follows them', () => {
  const frags = countEntries(scenes, 'FRAGS');
  const after = countEntries(scenes, 'AFTER');
  assert.ok(frags > 0, 'FRAGS must have entries');
  assert.equal(
    after, frags,
    'FRAGS and AFTER are index-matched one-per-tile: removing from one side without '
    + 'the other throws on the tile with no partner',
  );
  // The loop must not hard-code the count either, or the next edit reintroduces it.
  assert.match(scenes, /for\(var i=0;i<FRAGS\.length;i\+\+\)/, 'the tile count is derived from FRAGS');
});

test('the framework does not reach forward into the scenes', () => {
  // It used to call buildCC() and goTo() directly — functions declared hundreds
  // of lines below it, which only worked while everything shared one closure.
  for (const name of ['buildCC', 'goTo(', 'layoutConv']) {
    assert.ok(!scroll.includes(name), `presentation-scroll.js must not reference ${name}`);
  }
  assert.ok(scroll.includes('onLangChange'), 'it offers a hook instead');
  assert.ok(scenes.includes('onLangChange(buildCC)'), 'and the scenes register with it');
});

test('the removed features leave no trace a visitor could see', () => {
  // Comments are stripped first: the code may still EXPLAIN why the Trailers
  // capability went (that history is why the parity test above exists), but
  // nothing a browser renders or executes may mention it.
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const all = [html, engine, scroll, scenes, read('presentation.css')].map(strip).join('\n');
  for (const gone of ['Trailer', 'trailer', 'Трейлер', 'QBQ', 'SOS', 'FleetView']) {
    assert.ok(!all.includes(gone), `the deck must not mention ${gone}`);
  }
});
