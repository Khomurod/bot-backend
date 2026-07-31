/**
 * Regression guard on the uploaded deck itself.
 *
 * The presentation is a hand-finished artifact, not generated output — the
 * cheapest way to break it is an edit that quietly drops a slide, an animation
 * or a font. This suite pins the things a reviewer cannot eyeball in a 4000-line
 * diff, and it pins the exact approved wordings so a later "tidy-up" cannot
 * silently revert them.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const {
  TEMPLATE_PATH, SENTINEL_START, SENTINEL_END, HOSTED_SCRIPTS, renderPresentation, substitute,
} = require('../server/qbq/template');

const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');

test('all 28 slides are present and numbered through to the last', () => {
  const slides = template.match(/^<section data-label=/gm) || [];
  assert.equal(slides.length, 28);
  assert.ok(template.includes('data-screen-label="01"'), 'first slide');
  assert.ok(template.includes('data-screen-label="28"'), 'last slide');
  assert.ok(!template.includes('data-screen-label="29"'), 'no extra slide crept in');
});

test('the three approved wording corrections are in place', () => {
  const expected = [
    'Muammo kimning aybi bo‘lishidan qat’i nazar, men hozir vaziyatni oldinga siljitish uchun nima qila olaman?',
    'Muammo bu savollarning paydo bo‘lishida emas, ular bizni qanday harakatga olib borishida.',
    'Ikki oy o‘tib, Jeykob lavozimga ko‘tarildi.',
  ];
  for (const sentence of expected) {
    assert.equal(
      (template.match(new RegExp(sentence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length,
      1,
      `expected exactly one occurrence of: ${sentence}`,
    );
  }
});

test('the superseded wordings are gone', () => {
  const removed = [
    'qat’i nazar: men hozir',
    'Muammo ularning yomonligida emas, natijasida.',
    'Ikki oydan keyin Jeykob lavozimda ko‘tarilgan edi.',
  ];
  for (const sentence of removed) {
    assert.ok(!template.includes(sentence), `old wording still present: ${sentence}`);
  }
});

test('the deck runtime, animations, notes and typography are intact', () => {
  assert.match(template, /<deck-stage width="1920" height="1080">/);
  assert.match(template, /customElements\.define\('deck-stage', DeckStage\)/);
  // The public API the remote drives.
  for (const member of ['get index()', 'get length()', 'goTo(i)', 'next()', 'prev()']) {
    assert.ok(template.includes(member), `deck-stage must still expose ${member}`);
  }
  assert.ok(template.includes("new CustomEvent('slidechange'"), 'slidechange event');
  // Fullscreen control and its Uzbek labels.
  assert.ok(template.includes('id="sos-fs"'));
  assert.ok(template.includes('requestFullscreen'));
  // Animations and speaker notes.
  for (const anim of ['rise', 'fade', 'wipe', 'pop', 'pulse', 'dash']) {
    assert.ok(template.includes(`data-anim="${anim}"`), `animation ${anim} missing`);
  }
  assert.ok((template.match(/data-speaker-notes=/g) || []).length >= 28, 'speaker notes on every slide');
});

test('the deck is offline-safe: no external asset of any kind', () => {
  // Anything fetched from another host would break the "offline" promise and
  // the "no CDN" requirement at once.
  const external = template.match(/(?:src|href)="https?:\/\/[^"]+"/g) || [];
  assert.deepEqual(external, [], `external references found: ${external.join(', ')}`);
  assert.ok(!/@import\s+url\(\s*["']?https?:/.test(template), 'no remote @import');
});

test('the LOCAL-SAVE sentinels exist exactly once and in order', () => {
  assert.equal(template.split(SENTINEL_START).length - 1, 1, 'one start sentinel');
  assert.equal(template.split(SENTINEL_END).length - 1, 1, 'one end sentinel');
  assert.ok(template.indexOf(SENTINEL_START) < template.indexOf(SENTINEL_END), 'ordered');

  // The block between them must still be the OFFLINE editor, so opening the
  // file straight from disk keeps working.
  const between = template.slice(
    template.indexOf(SENTINEL_START),
    template.indexOf(SENTINEL_END),
  );
  assert.match(between, /showSaveFilePicker/, 'offline save path lives inside the sentinels');
  assert.match(between, /addEventListener\('dblclick'/, 'offline double-click editing too');
});

test('rendering swaps only the sentinel block and leaves every slide untouched', () => {
  const { html, substituted } = renderPresentation({ overrides: [] });
  assert.equal(substituted, true);

  assert.equal((html.match(/^<section data-label=/gm) || []).length, 28, 'no slide lost');
  assert.ok(!html.includes('showSaveFilePicker'), 'offline save path removed');
  assert.ok(!html.includes(SENTINEL_START) && !html.includes(SENTINEL_END), 'sentinels consumed');
  for (const asset of HOSTED_SCRIPTS) {
    assert.ok(html.includes(`/qbq/assets/${asset}`), `hosted script ${asset} injected`);
  }

  // Everything before the sentinel is byte-identical — the swap cannot drift.
  const cut = template.indexOf(SENTINEL_START);
  assert.equal(html.slice(0, cut), template.slice(0, cut),
    'the entire document above the sentinel must be passed through unchanged');
  assert.match(html, /<\/body>\s*<\/html>\s*$/, 'document still closes properly');
});

test('a template without a usable sentinel pair is served unchanged rather than cut', () => {
  // The failure mode that matters: if a sentinel is removed, duplicated or
  // reordered, the deck must still render whole instead of being sliced at a
  // guessed offset. Tested against strings — nothing here rewrites the deck.
  const broken = {
    'start sentinel removed': template.replace(SENTINEL_START, '<!-- gone -->'),
    'end sentinel removed': template.replace(SENTINEL_END, '<!-- gone -->'),
    'start sentinel duplicated': template.replace(SENTINEL_START, `${SENTINEL_START}\n${SENTINEL_START}`),
    'end sentinel duplicated': template.replace(SENTINEL_END, `${SENTINEL_END}\n${SENTINEL_END}`),
    'sentinels reordered': template
      .replace(SENTINEL_START, '@@TMP@@').replace(SENTINEL_END, SENTINEL_START).replace('@@TMP@@', SENTINEL_END),
    'both missing': template.replace(SENTINEL_START, '').replace(SENTINEL_END, ''),
  };

  for (const [label, source] of Object.entries(broken)) {
    const { html, substituted } = substitute(source, { deckKey: 'x', overrides: [] });
    assert.equal(substituted, false, `${label}: substitution must refuse to guess`);
    assert.equal(html, source, `${label}: the template must be passed through untouched`);
    assert.equal((html.match(/^<section data-label=/gm) || []).length, 28,
      `${label}: the deck must still be whole`);
  }
});

test('the deck on disk is never written to by rendering it', () => {
  const before = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  renderPresentation({ overrides: [{ elementPath: 's1.0', content: 'Yangi' }] });
  renderPresentation({ overrides: [] });
  assert.equal(fs.readFileSync(TEMPLATE_PATH, 'utf8'), before,
    'the uploaded presentation is the source template and must stay immutable');
});
