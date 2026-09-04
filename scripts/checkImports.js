#!/usr/bin/env node
/**
 * Does every local import actually name something its module exports?
 *
 * THE GAP THIS CLOSES. `npm run lint:undef` catches a name that is used but
 * never declared. It cannot catch the mirror image: a name that IS declared —
 * by an import statement or a destructured require — pointing at a module
 * that does not export it. The identifier is in scope, so no scope check
 * complains; the value is simply `undefined`, and the failure surfaces the
 * first time an admin opens the page or the scheduler calls the function.
 *
 * That is the same "passes the build, breaks when opened" class as the 26
 * identifiers a module split left behind, and the bundler is no help: Rollup
 * only WARNS about a missing named export and emits `undefined`.
 *
 * What it checks, for relative (in-repo) targets only:
 *   ESM  `import { a, b as c } from './x'`   → x must export a and b
 *   ESM  `import D from './x'`               → x must have a default export
 *   CJS  `const { a } = require('./x')`      → x's module.exports must have a
 *
 * Package imports are out of scope: node_modules is installed code with its
 * own tests, and re-implementing Node + Vite resolution for it would add a
 * second source of truth to keep correct.
 *
 * Deliberately conservative. A module whose export surface cannot be read
 * statically — a spread, a computed key, `module.exports = someValue` — is
 * SKIPPED rather than reported, because one false positive in a correctness
 * gate is how the gate gets switched off.
 *
 * Usage:
 *   node scripts/checkImports.js          # enforce (CI)
 *   node scripts/checkImports.js --list   # report every finding
 *
 * Exported for tests/checkImports.test.js.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { collectSourceFiles } = require('./checkFileSize');
const {
  CODE_EXTENSIONS, resolveLocal, collectImportSites, readExports,
} = require('./importScan/surface');

const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Every local import of a name its target module does not export.
 * Returns `[{ file, line, specifier, name }]` sorted by file, then line.
 */
function findMissingImports(root = REPO_ROOT) {
  const findings = [];
  const cache = new Map();
  const exportsOf = (abs) => {
    if (!cache.has(abs)) cache.set(abs, readExports(abs));
    return cache.get(abs);
  };

  for (const rel of collectSourceFiles(root)) {
    if (!CODE_EXTENSIONS.includes(path.extname(rel))) continue;
    const abs = path.join(root, rel);
    let raw;
    try {
      raw = fs.readFileSync(abs, 'utf8');
    } catch (e) {
      continue;
    }

    for (const site of collectImportSites(raw)) {
      if (!site.specifier.startsWith('.')) continue;
      // `?raw` / `?url` / `?inline` import the FILE, not its module surface:
      // the bundler hands back a string, so its default export always exists.
      if (site.specifier.includes('?')) continue;

      const target = resolveLocal(abs, site.specifier);
      if (!target) {
        findings.push({ file: rel, line: site.line, specifier: site.specifier, name: '(module not found)' });
        continue;
      }
      const surface = exportsOf(target);
      if (!surface.complete) continue;
      for (const name of site.names) {
        if (!surface.names.has(name)) {
          findings.push({ file: rel, line: site.line, specifier: site.specifier, name });
        }
      }
    }
  }

  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

function formatFinding(finding) {
  const what = finding.name === 'default'
    ? 'no default export in'
    : `'${finding.name}' is not exported by`;
  return `${finding.file}:${finding.line}  ${what} '${finding.specifier}'`;
}

function listAll(root = REPO_ROOT) {
  const findings = findMissingImports(root);
  findings.forEach((finding) => console.log(formatFinding(finding)));
  console.log(findings.length
    ? `\n${findings.length} broken import(s).`
    : 'OK — every local import resolves to a real export.');
  return 0;
}

function enforce(root = REPO_ROOT) {
  const findings = findMissingImports(root);
  if (!findings.length) {
    console.log('OK — every local import resolves to a real export.');
    return 0;
  }
  console.error('Imports naming something their module does not export:\n');
  findings.forEach((finding) => console.error(`  ${formatFinding(finding)}`));
  console.error('\nThese pass the build and fail at runtime. Fix the import or the export.');
  return 1;
}

function main() {
  process.exit(process.argv.includes('--list') ? listAll() : enforce());
}

if (require.main === module) main();

module.exports = { REPO_ROOT, findMissingImports, listAll, enforce };
