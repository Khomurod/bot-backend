'use strict';

/**
 * Renders the hosted /qbq page from the uploaded deck.
 *
 * The uploaded file is the SOURCE TEMPLATE and is never written to. Serving it
 * as one self-contained document is what makes a direct hit and a refresh
 * behave identically, and it keeps the repository filename out of the public
 * URL. This mirrors the existing /presentation route in healthRoutes.js.
 *
 * The only substitution is the block between the QBQ:LOCAL-SAVE sentinels: the
 * deck ships an offline "write the whole page back to a file" editor that is
 * meaningless over HTTP, so the hosted copy swaps it for the database-backed
 * editor. Everything else — every slide, style, animation, font and the
 * fullscreen control — is passed through byte for byte.
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * The uploaded deck. Named here once, so a rename is a one-line change and the
 * filename never leaks into a URL or a client-visible string.
 */
const TEMPLATE_FILENAME = 'SOS Prezentatsiya (offline v2) (1).html';
const TEMPLATE_PATH = path.join(__dirname, '..', '..', TEMPLATE_FILENAME);

const SENTINEL_START = '<!-- QBQ:LOCAL-SAVE-START -->';
const SENTINEL_END = '<!-- QBQ:LOCAL-SAVE-END -->';

/** Hosted replacements for the offline save block, in load order. */
const HOSTED_SCRIPTS = ['qbq-auth.js', 'qbq-edit.js', 'qbq-zoom.js', 'qbq-remote-link.js'];

let cache = { mtimeMs: 0, size: 0, html: '' };

/** Read the template, re-reading only when the file on disk actually changed. */
function readTemplate() {
  const stat = fs.statSync(TEMPLATE_PATH);
  if (cache.html && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
    return cache.html;
  }
  const html = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  cache = { mtimeMs: stat.mtimeMs, size: stat.size, html };
  return html;
}

/**
 * Serialize a value for embedding inside a <script> element.
 *
 * Escaping "<" is the whole point: without it, a stored value containing
 * "</script>" would close the tag early and everything after it would be parsed
 * as markup. Stored content is already plain text (sanitizeEditableText), so
 * this is the second independent reason the page cannot be script-injected.
 */
function toScriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003C')
    .replace(/>/g, '\\u003E')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function buildHostedBlock(payload) {
  const tags = HOSTED_SCRIPTS
    .map((name) => `<script src="/qbq/assets/${name}"></script>`)
    .join('\n');
  return [
    '<!-- QBQ hosted editor: server-backed replacement for the offline save block. -->',
    `<script>window.__QBQ__ = ${toScriptJson(payload)};</script>`,
    tags,
  ].join('\n');
}

/**
 * Build the page.
 *
 * @param {object} options
 * @param {Array<{elementPath:string, content:string}>} [options.overrides]
 *   Saved text overrides, inlined so an edited slide never flashes its original
 *   wording. The component holds paint until fonts resolve
 *   (:host([data-fonts-pending]) .stage{opacity:0}), and a classic script before
 *   </body> runs before that, so applying them client-side is not visible.
 * @param {string} [options.deckKey]
 * @returns {{html: string, substituted: boolean}}  `substituted` false means the
 *   sentinels were not found exactly once and the template was served UNCHANGED
 *   rather than cut at a guessed offset.
 */
function renderPresentation({ overrides = [], deckKey = 'sos-offline-v2' } = {}) {
  return substitute(readTemplate(), { deckKey, overrides, hosted: true });
}

/**
 * The substitution itself, as a pure function of the template text.
 *
 * Separated from disk I/O so the "refuse to guess" rule can be tested against a
 * mutated STRING — a test must never have to rewrite the real deck on disk to
 * prove what happens when its sentinels are wrong.
 *
 * @param {string} template
 * @param {object} payload inlined as window.__QBQ__
 * @returns {{html: string, substituted: boolean}}
 */
function substitute(template, payload) {
  const startCount = template.split(SENTINEL_START).length - 1;
  const endCount = template.split(SENTINEL_END).length - 1;
  const start = template.indexOf(SENTINEL_START);
  const end = template.indexOf(SENTINEL_END);

  // Refuse to cut on anything but an exact, well-ordered, unique pair. A
  // scripted edit against a moved offset is how a working page becomes a
  // broken one, so the failure mode here is "serve the original", not "guess".
  if (startCount !== 1 || endCount !== 1 || start < 0 || end < start) {
    return { html: template, substituted: false };
  }

  const hosted = buildHostedBlock(payload);
  const html = template.slice(0, start) + hosted + template.slice(end + SENTINEL_END.length);
  return { html, substituted: true };
}

/** Clear the file cache (tests that rewrite the template on disk). */
function __resetCacheForTests() {
  cache = { mtimeMs: 0, size: 0, html: '' };
}

module.exports = {
  TEMPLATE_FILENAME,
  TEMPLATE_PATH,
  SENTINEL_START,
  SENTINEL_END,
  HOSTED_SCRIPTS,
  readTemplate,
  toScriptJson,
  substitute,
  renderPresentation,
  __resetCacheForTests,
};
