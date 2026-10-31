/**
 * The repository describes one way to run the app: the Docker image Coolify
 * builds. The October 2026 hidden-functions audit removed what still described
 * another, and this keeps it removed:
 *   - render.yaml       applied again beside Coolify, it would start a second
 *                       copy of the bot (and of the leads worker) on the same
 *                       tokens: Telegram 409s and every scheduler twice;
 *   - check-prod-env    checked a list of variables that was not the app's
 *                       (the app checks its own, `assertRequiredConfig`), and
 *                       the deploy checklist told you to run an npm script
 *                       that did not exist;
 *   - npm bot / server  ran modules that only export a start function, so they
 *                       exited at once having started nothing;
 *   - npm start         carried Render's 256 MB heap flag while production ran
 *                       with the Dockerfile's 1024.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const rootScripts = JSON.parse(read('package.json')).scripts;
const adminScripts = JSON.parse(read('admin/package.json')).scripts;

test('the Render blueprint and the old env checker are gone', () => {
  for (const file of ['render.yaml', 'scripts/check-prod-env.js']) {
    assert.equal(fs.existsSync(path.join(ROOT, file)), false, `${file} must not come back`);
  }
});

test('npm start runs what the Docker image runs; the heap cap lives only in the Dockerfile', () => {
  const dockerfile = read('Dockerfile');
  const cmd = dockerfile.match(/^CMD\s+(\[.*\])\s*$/m);
  assert.ok(cmd, 'the Dockerfile has an exec-form CMD');
  assert.equal(rootScripts.start, JSON.parse(cmd[1]).join(' '));
  assert.match(dockerfile, /NODE_OPTIONS=--max-old-space-size=\d+/);
  assert.doesNotMatch(rootScripts.start, /max-old-space-size/);
});

test('every npm script that runs a file names one that exists, and none runs a module that only exports', () => {
  for (const [name, command] of Object.entries(rootScripts)) {
    for (const m of command.matchAll(/\b(?:node|python)\s+(?:-[\w-]+(?:=\S+)?\s+)*([\w./-]+\.(?:js|py))\b/g)) {
      assert.ok(fs.existsSync(path.join(ROOT, m[1])), `npm run ${name} names ${m[1]}, which does not exist`);
    }
    // bot/bot.js and server/api.js export startBot / startServer; index.js calls them.
    assert.doesNotMatch(command, /\bnode\s+(?:bot\/bot|server\/api)\.js\b/, `npm run ${name} would start nothing`);
  }
});

// The records of removed features describe commands that went with them.
const HISTORICAL = (rel) => rel === 'docs/ARCHIVED_FEATURES.md' || /(^|\/)retired-[^/]*\.md$/.test(rel);

// Local working folders .gitignore keeps out of the repository: a note there is
// not documentation, and may well mention a command that is gone.
const LOCAL_WORKING_DIRS = new Set(['scratch', 'brain', 'reports', '.cursor']);

function markdownFiles(dir, out = []) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (['node_modules', '.git', 'build', 'dist'].includes(entry.name)) continue;
    if (!dir && LOCAL_WORKING_DIRS.has(entry.name)) continue;
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) markdownFiles(rel, out);
    else if (rel.endsWith('.md') && !HISTORICAL(rel)) out.push(rel);
  }
  return out;
}

test('every `npm run` a document tells you to type exists', () => {
  // Also read across code spans: the checklist once wrote `npm run` `check-prod-env`.
  const missing = [];
  for (const rel of markdownFiles('')) {
    read(rel).split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/npm run`?\s+`?([a-z][\w:.-]*)`?(?:\s+--\s+\S+)*(?:\s+--prefix\s+([\w./-]+))?/g)) {
        const scripts = m[2] && m[2].startsWith('admin') ? adminScripts : rootScripts;
        if (!(m[1] in scripts)) missing.push(`${rel}:${i + 1} npm run ${m[1]}${m[2] ? ` --prefix ${m[2]}` : ''}`);
      }
    });
  }
  assert.deepEqual(missing, []);
});
