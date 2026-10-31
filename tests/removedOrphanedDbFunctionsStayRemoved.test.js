'use strict';

/**
 * Database functions nothing called stay removed (October 2026, the
 * hidden-functions audit, block 4a, at the owner's decision).
 *
 * Most lost their only caller when a route went: the old Driver Groups API, a
 * correction's detail, a knowledge entry's history, the old survey list. The
 * rest never had one. None changed anything while unused; the risk was a later
 * change wiring one back in beside the path that runs, past the checks that
 * path makes. The two rules that used to be tested THROUGH them are now held on
 * the live path: the group-row cache is forgotten after a profile save
 * (tests/perMessageQueries.test.js), and a status a person set is `manual` and
 * left alone by the AI pass (tests/manualStatusLockPg.test.js).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const REMOVED = {
  'database/groups.js': ['setGroupStatusByAdmin', 'setGroupLanguage', 'setGroupBirthday'],
  'database/operationalCorrections.js': ['getCorrectionById', 'listAuditForSubject'],
  'database/recruitingKnowledge.js': ['knowledgeHistory'],
  'database/questions.js': ['getActiveQuestions'],
  'database/scheduledMessages.js': ['deleteScheduledMessage'],
  'database/homeTime/returnWatch.js': ['clearWatch'],
  'database/aiProviderModelCooldowns.js': ['clearAllModelPauses'],
  'database/operationalDecisions.js': ['pruneDecisions'],
};

const ALL = Object.values(REMOVED).flat();
const word = (name) => new RegExp(`\\b${name}\\b`);

test('the modules no longer define or export them', () => {
  for (const [rel, names] of Object.entries(REMOVED)) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const name of names) assert.doesNotMatch(src, word(name), `${rel} must not bring back ${name}`);
  }
});

// A deny-list, like scripts/checkFileSize.js: every directory is application
// code unless it is provably not, so a new one (utils/ was once missed) is
// covered the moment it exists.
const NOT_APPLICATION = new Set([
  'node_modules', '.git', 'build', 'dist', 'coverage', '__pycache__',
  'tests', 'docs', 'assets', 'leads-bot', 'scratch', 'brain', 'reports', '.cursor',
]);

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (NOT_APPLICATION.has(entry.name)) continue;
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) sourceFiles(rel, out);
    else if (/\.(js|jsx|mjs|cjs)$/.test(entry.name) && !/\.test\.jsx?$/.test(entry.name)) out.push(rel);
  }
  return out;
}

test('no application code calls them', () => {
  const files = sourceFiles('');
  assert.ok(files.includes('index.js') && files.includes('utils/audioDuration.js'),
    'the scan reaches the root and every application directory');
  const offenders = [];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const name of ALL) if (word(name).test(src)) offenders.push(`${rel}: ${name}`);
  }
  assert.deepEqual(offenders, []);
});
