'use strict';

/**
 * What a module imports, and what it exports.
 *
 * Both are read from SCRUBBED source (see ./source.js): comments, string
 * bodies and regex literals are blanked first, so a doc-comment example or a
 * fixture module written as a string is not mistaken for real code. Scrubbing
 * is length-preserving, so a specifier's real text is sliced out of the
 * ORIGINAL source at the matched offsets — which is why every pattern here
 * carries the `d` flag.
 */

const fs = require('node:fs');
const path = require('node:path');

const { scrubNonCode, braceBlock, objectKeys, requestedNames } = require('./source');

const CODE_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs'];

/** Resolve a relative specifier the way Node and Vite both would. */
function resolveLocal(fromFile, specifier) {
  // Vite query suffixes (`?raw`, `?url`) address the same file.
  const clean = String(specifier).split('?')[0];
  const base = path.resolve(path.dirname(fromFile), clean);
  const candidates = [base];
  for (const ext of CODE_EXTENSIONS) candidates.push(base + ext);
  for (const ext of CODE_EXTENSIONS) candidates.push(path.join(base, `index${ext}`));
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (e) { /* next candidate */ }
  }
  return null;
}

/** The text at a capture group's offsets in the original source. */
const groupText = (raw, match, group) => {
  const range = match.indices && match.indices[group];
  return range ? raw.slice(range[0], range[1]) : '';
};

const IMPORT_FROM = /import\s+([^;'"]+?)\s+from\s*['"]([^'"]+)['"]/dg;
const DESTRUCTURED_REQUIRE = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/dg;

/**
 * Every import site in a file: `{ specifier, names, line }`, where `names` are
 * the names requested FROM the module (`default` for a default import).
 * Package imports are included; callers filter to relative ones.
 */
function collectImportSites(raw) {
  const code = scrubNonCode(raw);
  const lineOf = (index) => code.slice(0, index).split('\n').length;
  const sites = [];

  for (const m of code.matchAll(IMPORT_FROM)) {
    const clause = groupText(raw, m, 1).trim();
    const names = [];
    const braces = clause.match(/\{([^}]*)\}/);
    if (braces) names.push(...requestedNames(braces[1]));
    const bare = clause.replace(/\{[^}]*\}/, '').replace(/,/g, ' ').trim();
    // `import * as ns from` binds a namespace object: no single name to verify.
    if (bare && !bare.startsWith('*') && /^[A-Za-z_$][\w$]*$/.test(bare)) names.push('default');
    sites.push({ specifier: groupText(raw, m, 2), names, line: lineOf(m.index) });
  }

  for (const m of code.matchAll(DESTRUCTURED_REQUIRE)) {
    sites.push({
      specifier: groupText(raw, m, 2),
      names: requestedNames(groupText(raw, m, 1)),
      line: lineOf(m.index),
    });
  }

  return sites;
}

const EXPORT_DECL = /export\s+(?:async\s+)?(?:function\*?|class)\s+([A-Za-z_$][\w$]*)/g;
const EXPORT_BINDING = /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g;
const EXPORT_DESTRUCTURED = /export\s+(?:const|let|var)\s*\{([^}]*)\}/g;
const EXPORT_LIST = /export\s*\{([^}]*)\}/g;
const EXPORT_STAR = /export\s*\*\s*(?:as\s+([A-Za-z_$][\w$]*)\s+)?from\s*['"]([^'"]+)['"]/dg;
const CJS_NAMED = /(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/g;
const CJS_OBJECT = /module\.exports\s*=\s*\{/g;
const CJS_REEXPORT = /module\.exports\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/dg;
const CJS_ASSIGN = /module\.exports\s*=/g;

/**
 * The names a module exports, and whether that surface is fully knowable.
 *
 * `complete: false` means "report nothing against this module": a spread, a
 * computed key, an unresolvable star re-export or an assignment of some
 * runtime value could supply any name, and guessing would produce exactly the
 * false positives that make a gate worthless.
 */
function readExports(absPath, seen = new Set()) {
  const names = new Set();
  if (seen.has(absPath)) return { names, complete: true };
  seen.add(absPath);

  let raw;
  try {
    raw = fs.readFileSync(absPath, 'utf8');
  } catch (e) {
    return { names, complete: false };
  }
  const code = scrubNonCode(raw);
  let complete = true;

  const follow = (specifier) => {
    const target = specifier.startsWith('.') ? resolveLocal(absPath, specifier) : null;
    if (!target) { complete = false; return; }
    const nested = readExports(target, seen);
    for (const name of nested.names) names.add(name);
    if (!nested.complete) complete = false;
  };

  // ── ES modules ──
  for (const m of code.matchAll(EXPORT_DECL)) names.add(m[1]);
  for (const m of code.matchAll(EXPORT_BINDING)) names.add(m[1]);
  for (const m of code.matchAll(EXPORT_DESTRUCTURED)) {
    for (const name of requestedNames(m[1])) names.add(name);
  }
  if (/export\s+default\b/.test(code)) names.add('default');
  for (const m of code.matchAll(EXPORT_LIST)) {
    for (const piece of m[1].split(',')) {
      const parts = piece.split(/\s+as\s+/).map((s) => s.trim()).filter(Boolean);
      const exported = parts.length > 1 ? parts[1] : parts[0];
      if (/^[A-Za-z_$][\w$]*$/.test(exported || '')) names.add(exported);
    }
  }
  for (const m of code.matchAll(EXPORT_STAR)) {
    if (m[1]) { names.add(m[1]); continue; }
    follow(groupText(raw, m, 2));
  }

  // ── CommonJS ──
  for (const m of code.matchAll(CJS_NAMED)) names.add(m[1]);
  const objectAssignments = [...code.matchAll(CJS_OBJECT)];
  for (const m of objectAssignments) {
    const parsed = objectKeys(braceBlock(code, m.index + m[0].length - 1));
    for (const name of parsed.names) names.add(name);
    if (!parsed.complete) complete = false;
    names.add('default');
  }
  const reexports = [...code.matchAll(CJS_REEXPORT)];
  for (const m of reexports) {
    follow(groupText(raw, m, 1));
    names.add('default');
  }
  // Any other `module.exports = <value>` — a class, a function, an identifier:
  // the surface depends on runtime, so nothing can be reported against it.
  const assignments = [...code.matchAll(CJS_ASSIGN)];
  if (assignments.length > objectAssignments.length + reexports.length) {
    complete = false;
    names.add('default');
  }

  return { names, complete };
}

module.exports = { CODE_EXTENSIONS, resolveLocal, collectImportSites, readExports };
