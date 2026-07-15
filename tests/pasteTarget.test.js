/**
 * Unit tests for the Route Control screenshot paste-target router
 * (admin/src/pages/pasteTarget.mjs). Pure/deterministic — no DOM. Imported via a
 * file:// URL so the dynamic ESM import works on Windows too.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MOD = pathToFileURL(path.resolve(__dirname, '../admin/src/pages/pasteTarget.mjs')).href;

// A clipboard items list carrying one image file (mimics DataTransferItemList).
const imageItems = (file = { name: 'x.png', type: 'image/png' }) => [
  { kind: 'string', type: 'text/plain', getAsFile: () => null },
  { kind: 'file', type: 'image/png', getAsFile: () => file },
];
const textItems = [{ kind: 'string', type: 'text/plain', getAsFile: () => null }];

test('with no active target, an image paste is ignored (does not steal into any form)', async () => {
  const { createPasteRouter } = await import(MOD);
  const router = createPasteRouter();
  assert.equal(router.getActiveId(), null);
  assert.equal(router.handlePaste(imageItems()), null);
});

test('pasting routes ONLY to the active target', async () => {
  const { createPasteRouter } = await import(MOD);
  const router = createPasteRouter();
  const got = { assign: 0, row5: 0 };
  router.setActive('assign', () => { got.assign += 1; });
  assert.equal(router.getActiveId(), 'assign');
  assert.equal(router.handlePaste(imageItems()), 'assign');
  assert.deepEqual(got, { assign: 1, row5: 0 });

  // Opening a route panel makes it the sole active target.
  router.setActive('row:5', () => { got.row5 += 1; });
  assert.equal(router.getActiveId(), 'row:5');
  assert.equal(router.handlePaste(imageItems()), 'row:5');
  assert.deepEqual(got, { assign: 1, row5: 1 }, 'the upper form did not also receive the paste');
});

test('two open panels never both accept one paste (last active wins)', async () => {
  const { createPasteRouter } = await import(MOD);
  const router = createPasteRouter();
  let a = 0; let b = 0;
  router.setActive('row:1', () => { a += 1; });
  router.setActive('row:2', () => { b += 1; });
  router.handlePaste(imageItems());
  assert.equal(a, 0);
  assert.equal(b, 1);
});

test('clearActive only clears when it still owns the slot', async () => {
  const { createPasteRouter } = await import(MOD);
  const router = createPasteRouter();
  let assignHits = 0;
  router.setActive('assign', () => { assignHits += 1; });
  router.setActive('row:5', () => {});
  // The upper form clearing itself must NOT clear the row that took over.
  router.clearActive('assign');
  assert.equal(router.getActiveId(), 'row:5');
  // Closing the row clears it → nothing active → paste ignored.
  router.clearActive('row:5');
  assert.equal(router.getActiveId(), null);
  assert.equal(router.handlePaste(imageItems()), null);
  assert.equal(assignHits, 0);
});

test('text-only clipboard is ignored by screenshot handlers (normal paste continues)', async () => {
  const { createPasteRouter } = await import(MOD);
  const router = createPasteRouter();
  let hits = 0;
  router.setActive('assign', () => { hits += 1; });
  assert.equal(router.handlePaste(textItems), null);
  assert.equal(hits, 0);
});

test('a target set without a handler safely ignores pastes', async () => {
  const { createPasteRouter } = await import(MOD);
  const router = createPasteRouter();
  router.setActive('assign', null);
  assert.equal(router.handlePaste(imageItems()), null);
});
