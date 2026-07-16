/**
 * Trailer creation flows: the Trailers page dialog and the two New Rental Draft
 * quick-adds. createTrailer is exercised for real against a stubbed fetch; the
 * dialogs are verified as source contracts (no admin component-test runner —
 * the Vite build covers JSX validity).
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ADMIN = path.resolve(__dirname, '../admin/src');
const read = (relative) => fs.readFileSync(path.join(ADMIN, relative), 'utf8');
/** Comments discuss <form> deliberately — only real markup should be matched. */
const readCode = (relative) => read(relative).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

async function withStubbedFetch(run) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  const originalStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => 'test-token' };
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ trailer: { id: 7, unit_number: 'T-7' } }),
    };
  };
  try {
    await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalStorage;
  }
}

test('createTrailer posts to the existing department endpoint', async () => {
  await withStubbedFetch(async (calls) => {
    const api = await import(pathToFileURL(path.join(ADMIN, 'api/trailerDepartment.js')).href);
    const body = { unit_number: 'T-7', physical_status: 'available', needs_review: false };
    const result = await api.createTrailer(body);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/trailer-department/trailers');
    assert.equal(calls[0].options.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].options.body), body);
    assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token');
    assert.equal(result.trailer.id, 7);
    assert.equal(typeof api.default.createTrailer, 'function');
    assert.equal(typeof api.default.status, 'function');
  });
});

test('the status client reads the dedicated status endpoint', async () => {
  await withStubbedFetch(async (calls) => {
    const api = await import(pathToFileURL(path.join(ADMIN, 'api/trailerDepartment.js')).href);
    await api.status();
    assert.equal(calls[0].url, '/api/trailer-department/status');
  });
});

test('Add trailer on the Trailers page is permission-aware and keeps Refresh', () => {
  const page = read('pages/trailer/TrailerAssetsPage.jsx');
  assert.ok(/hasTrailerPermission\(permissions, "trailers\.create"\)/.test(page));
  assert.ok(/\{canCreate && \(/.test(page), 'Add trailer must be gated on trailers.create');
  assert.ok(/onClick=\{reload\}>\s*Refresh/.test(page), 'Refresh must remain a separate action');
});

test('the trailer dialog defaults safely and preserves review requirements', () => {
  const dialog = read('pages/trailer/TrailerCreateDialog.jsx');
  assert.ok(/physical_status: "unknown"/.test(dialog), 'physical status defaults to unknown');
  assert.ok(/verified: false/.test(dialog), 'verification starts unchecked');
  // needs_review is the inverse of the checkbox: unverified stays review-required.
  assert.ok(/needs_review: !form\.verified/.test(dialog));
  assert.ok(
    /form\.physical_status === "available" && !form\.verified/.test(dialog),
    'available requires the verification checkbox',
  );
  assert.ok(/disabled=\{busy \|\| !form\.unit_number\.trim\(\) \|\| needsVerification\}/.test(dialog),
    'save must be disabled while submitting and until the form is valid');
  assert.ok(/setError\(e\.message\)/.test(dialog), 'backend validation errors must be shown');
  assert.ok(!/onClose\(\)/.test(dialog.split('catch (e) {')[1].split('}')[0] || ''),
    'a failure must not close the dialog');
});

test('inline trailer quick-add requires explicit availability verification', () => {
  const dialogs = read('pages/trailer/TrailerQuickAddDialogs.jsx');
  assert.ok(/canSave=\{Boolean\(unitNumber\.trim\(\)\) && verified\}/.test(dialogs),
    'saving must be blocked until the verification checkbox is checked');
  assert.ok(/if \(busy\) return;/.test(dialogs), 'duplicate submissions must be prevented');

  const page = read('pages/trailer/TrailerRentalsPage.jsx');
  assert.ok(/physical_status: "available",\s*needs_review: false,/.test(page),
    'inline creation records a verified, available trailer');
});

test('successful inline creation refreshes the list and selects the new trailer', () => {
  const page = read('pages/trailer/TrailerRentalsPage.jsx');
  assert.ok(/await assets\.reload\(\);\s*setCreate\(\(draft\) => \(\{ \.\.\.draft, trailer_id: String\(trailer\.id\) \}\)\)/.test(page),
    'the reloaded list must be selected by the returned trailer id, patching the draft');
  assert.ok(/await companies\.reload\(\);\s*setCreate\(\(draft\) => \(\{ \.\.\.draft, company_id: String\(company\.id\) \}\)\)/.test(page));
});

test('company quick-add maps the single name to legal_name and display_name', () => {
  const page = read('pages/trailer/TrailerRentalsPage.jsx');
  assert.ok(/api\.createCompany\(\{ legal_name: name, display_name: name \}\)/.test(page));
});

test('failed quick creation preserves the rental draft', () => {
  const page = read('pages/trailer/TrailerRentalsPage.jsx');
  // Quick-adds throw on failure; nothing in them clears or closes the draft.
  const quickAdd = page.split('const quickAddTrailer')[1].split('const activate')[0];
  assert.ok(!/setCreate\(null\)/.test(quickAdd), 'a failed quick-add must not discard the draft');

  const dialogs = read('pages/trailer/TrailerQuickAddDialogs.jsx');
  assert.ok(/setError\(e\.message\);\s*setBusy\(false\);/.test(dialogs),
    'errors surface in the quick-add dialog, which stays open');

  const draft = read('pages/trailer/TrailerRentalDraftDialog.jsx');
  assert.ok(/await onQuickAddTrailer\(unitNumber\);\s*setQuickAdd\(null\);/.test(draft),
    'only a successful quick-add closes the quick-add dialog');
});

test('quick-add dialogs never nest a form inside the rental draft form', () => {
  const draft = readCode('pages/trailer/TrailerRentalDraftDialog.jsx');
  const quickAddMarkup = draft.split('</div>').pop();
  assert.ok(!/<form/.test(quickAddMarkup), 'quick-add overlays must render outside the draft form');
  assert.equal((draft.match(/<form/g) || []).length, 1, 'the draft must contain exactly one form');

  const dialogs = readCode('pages/trailer/TrailerQuickAddDialogs.jsx');
  assert.ok(!/<form/.test(dialogs), 'quick-add dialogs must not use a form element');
  assert.ok(!/type="submit"/.test(dialogs), 'quick-add controls must not submit anything');
});

test('quick-add actions are permission-aware', () => {
  const draft = read('pages/trailer/TrailerRentalDraftDialog.jsx');
  assert.ok(/hasTrailerPermission\(permissions, "trailers\.create"\)/.test(draft));
  assert.ok(/hasTrailerPermission\(permissions, "trailer_companies\.manage"\)/.test(draft));
  assert.ok(/\{canAddTrailer && \(/.test(draft));
  assert.ok(/\{canAddCompany && \(/.test(draft));
});
