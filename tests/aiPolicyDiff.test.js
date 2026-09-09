/**
 * The gate that decides whether a model is ever called. PURE.
 *
 * Two failure modes with opposite costs, both real:
 *
 *   Too sensitive and the watcher alerts on every check. An alert that fires
 *   every time is one nobody reads — which leaves Wenze worse off than with no
 *   watcher, because now there is a green light nobody trusts.
 *
 *   Too blunt and a provider quietly starts training on submitted driver
 *   messages and nothing says so. That is the failure this feature exists for.
 *
 * So the tests come in pairs: for each kind of churn, prove it is ignored; and
 * for each thing that actually matters, prove it is not.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { normalisePolicyText, topicsIn } = require('../lib/ai/policyText');
const { comparePolicyText, diffLines, buildPassages, MATERIAL_CHARS } = require('../lib/ai/policyDiff');

const page = (body) => `
  <html><head><style>.x{color:red}</style><script>track()</script></head>
  <body>
    <nav><a href="/">Home</a><a href="/pricing">Pricing</a></nav>
    <header>We use cookies. <button>Accept all cookies</button></header>
    <main>${body}</main>
    <footer>© 2026 Example, Inc. Last updated: 4 March 2026</footer>
  </body></html>`;

// ─── churn that must never reach a model ─────────────────────────────────────

test('a re-render with a new date, year and build hash is not a change', () => {
  const before = normalisePolicyText(page('<p>You may use the API for commercial purposes.</p>'));
  const after = normalisePolicyText(`
    <html><body>
      <nav><a href="/">Home</a><a href="/pricing">Pricing</a><a href="/new">New</a></nav>
      <header>We use cookies. <button>Accept all cookies</button></header>
      <main><p>You may use the API for commercial purposes.</p></main>
      <footer>© 2027 Example, Inc. Last updated: 11 September 2026</footer>
      <script src="/app.js?v=9f2a1c4e5b6d7f80"></script>
    </body></html>`);

  const verdict = comparePolicyText(before, after);

  assert.equal(verdict.changed, false, 'no AI call, no finding, no alert');
  assert.equal(verdict.passages, '');
});

test('whitespace, entity and tag-shape differences are not a change', () => {
  const before = normalisePolicyText('<div><p>Free tier:  1,000 requests per day.</p></div>');
  const after = normalisePolicyText('<section><p>Free   tier: 1,000 requests per day.</p></section>');

  assert.equal(comparePolicyText(before, after).changed, false);
});

test('reordering sections is not a change to the terms', () => {
  const before = normalisePolicyText('<p>Alpha clause.</p><p>Beta clause.</p><p>Gamma clause.</p>');
  const after = normalisePolicyText('<p>Gamma clause.</p><p>Alpha clause.</p><p>Beta clause.</p>');

  const verdict = comparePolicyText(before, after);
  assert.equal(verdict.changed, false);
  assert.match(verdict.reason, /reordered/);
});

test('the first sight of a page is a baseline, never an alert', () => {
  const verdict = comparePolicyText('', normalisePolicyText(page('<p>Anything at all.</p>')));

  assert.equal(verdict.changed, false);
  assert.match(verdict.reason, /baseline/);
  // Otherwise switching the watcher on fires once per provider on day one,
  // which teaches an operator to ignore it immediately.
});

test('a small reworded aside in no watched section is recorded, not alerted', () => {
  const before = normalisePolicyText('<p>Contact support at help@example.com.</p><p>Free tier: 100/day.</p>');
  const after = normalisePolicyText('<p>Contact our team at help@example.com.</p><p>Free tier: 100/day.</p>');

  const verdict = comparePolicyText(before, after);

  assert.equal(verdict.changed, true, 'it did change');
  assert.equal(verdict.material, false, 'and it does not matter');
  assert.match(verdict.reason, /no watched section/);
});

// ─── what must always get through ────────────────────────────────────────────

test('one sentence about training on submissions is material, however short', () => {
  const before = normalisePolicyText('<p>We process your requests to return a response.</p>');
  const after = normalisePolicyText(
    '<p>We process your requests to return a response.</p>'
    + '<p>We may use your submissions to train our models.</p>'
  );

  const verdict = comparePolicyText(before, after);

  assert.equal(verdict.material, true);
  assert.ok(verdict.topics.includes('trains_on_data'));
  assert.ok(verdict.changedChars < MATERIAL_CHARS,
    'it is under the size threshold — WHERE has to outrank HOW MUCH or this is missed');
  assert.match(verdict.passages, /train our models/);
});

test('losing permission for commercial use is material', () => {
  const before = normalisePolicyText('<p>You may use the API for commercial purposes.</p>');
  const after = normalisePolicyText('<p>The API is for non-commercial use only.</p>');

  const verdict = comparePolicyText(before, after);
  assert.equal(verdict.material, true);
  assert.ok(verdict.topics.includes('commercial_use'));
  assert.match(verdict.passages, /ADDED:/);
  assert.match(verdict.passages, /REMOVED:/);
});

test('a deprecation notice is material', () => {
  const before = normalisePolicyText('<p>The v1 endpoint is available.</p>');
  const after = normalisePolicyText('<p>The v1 endpoint is deprecated and will be discontinued.</p>');

  assert.ok(comparePolicyText(before, after).topics.includes('discontinuation'));
});

test('a large rewrite is material even with no watched topic in it', () => {
  const before = normalisePolicyText('<p>Short.</p>');
  const after = normalisePolicyText(`<p>${'Entirely new prose about nothing in particular. '.repeat(6)}</p>`);

  const verdict = comparePolicyText(before, after);
  assert.equal(verdict.material, true);
  assert.match(verdict.reason, /characters changed/);
});

// ─── the passages that are the only thing a model ever sees ──────────────────

test('only the changed passages are quoted, never the whole document', () => {
  const unchanged = Array.from({ length: 200 },
    (_, i) => `<p>Clause ${i}: this paragraph is unchanged and quite long indeed.</p>`).join('');
  const before = normalisePolicyText(unchanged);
  const after = normalisePolicyText(
    `${unchanged}<p>We may use your submissions to train our models from now on.</p>`
  );

  const verdict = comparePolicyText(before, after);

  assert.match(verdict.passages, /train our models/);
  assert.equal(verdict.passages.includes('Clause 100'), false,
    'a model reading a whole terms page twice a week per provider is the workload this avoids');
  assert.ok(verdict.passages.length < before.length / 10);
});

test('an enormous diff is capped before it reaches a model', () => {
  const added = Array.from({ length: 500 },
    (_, i) => `Brand new clause number ${i} with a good deal of text in it.`);
  const passages = buildPassages({ added, removed: [] });

  assert.ok(passages.length <= 6000 + 20);
  assert.match(passages, /truncated/);
});

test('a short line is never dropped, and never only on one side', () => {
  // An earlier version filtered lines under 40 characters as "fragments". It
  // quoted the 44-character sentence that was REMOVED and dropped the
  // 39-character one that replaced it, so the change read as a permission
  // withdrawn with nothing in its place.
  const passages = buildPassages({
    added: ['The API is for non-commercial use only.'],
    removed: ['You may use the API for commercial purposes.'],
  });

  assert.match(passages, /ADDED:\nThe API is for non-commercial use only\./);
  assert.match(passages, /REMOVED:\nYou may use the API for commercial purposes\./);

  assert.match(buildPassages({ added: ['No opt-out.'], removed: [] }), /No opt-out/,
    'a short change under a watched topic is the case that matters most');
});

// ─── the pieces ──────────────────────────────────────────────────────────────

test('normalisation is idempotent, because a stored snapshot is re-compared', () => {
  const once = normalisePolicyText(page('<p>Free tier: 100 requests per day.</p>'));
  assert.equal(normalisePolicyText(once), once);
});

test('normalisation strips chrome but never sentence content', () => {
  const text = normalisePolicyText(page('<p>You must not resell access to the API.</p>'));

  assert.match(text, /must not resell access/);
  assert.equal(/Pricing|Accept all cookies|Example, Inc/.test(text), false);
});

test('a line that held only a date does not vanish and shift the diff', () => {
  // Replaced with a token rather than deleted: a deletion would move every
  // following line and make a re-render look like a restructure.
  const text = normalisePolicyText('<p>Last updated: 4 March 2026</p><p>Real clause.</p>');
  assert.match(text, /Real clause/);
});

test('topic detection reads the words a provider actually uses', () => {
  assert.deepEqual(topicsIn('requests per day on the free tier'), ['free_tier']);
  assert.ok(topicsIn('We retain prompts for 30 days').includes('retention'));
  assert.ok(topicsIn('not available in your region').includes('geography'));
  assert.deepEqual(topicsIn('The sky is blue.'), []);
});

test('a moved line is not counted as both added and removed', () => {
  const { added, removed } = diffLines('a\nb\nc', 'c\na\nb');
  assert.deepEqual(added, []);
  assert.deepEqual(removed, []);
});

test('a duplicated line counts once, not twice', () => {
  const { added } = diffLines('a\nb', 'a\nb\nb');
  assert.deepEqual(added, ['b']);
});
