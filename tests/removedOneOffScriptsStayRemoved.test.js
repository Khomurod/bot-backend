/**
 * One-time scripts removed in the October 2026 audit stay removed.
 *
 * Each wrote to the live database with no safety, and each had done its one
 * job long ago:
 *   - backfill-driver-profiles  wrote by default and overwrote every driver's
 *                               name, type, status, truck, language and dates —
 *                               every manual profile edit;
 *   - import-birthdays          overwrote groups.driver_birthday (still live)
 *                               from a CSV of 76 real drivers' names and birth
 *                               dates that was committed to the repository;
 *   - migrate-media             re-added questions.media_* columns long gone;
 *   - migrate-multi-media       a finished move to question_media, with a DROP.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

test('the scripts and the CSV of drivers\' birth dates are gone', () => {
  for (const file of [
    'scripts/backfill-driver-profiles.js', 'scripts/import-birthdays.js',
    'scripts/migrate-media.js', 'scripts/migrate-multi-media.js', 'birthdays.csv',
  ]) {
    assert.equal(fs.existsSync(path.join(ROOT, file)), false, `${file} must not come back`);
  }
});

test('no npm script names them, and the CSV cannot be committed again', () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
  for (const name of ['backfill-driver-profiles', 'migrate-media', 'migrate-multi-media']) {
    assert.equal(scripts[name], undefined, `npm run ${name} must not come back`);
  }
  const ignored = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split('\n').map((l) => l.trim());
  assert.ok(ignored.includes('birthdays.csv'), 'birthdays.csv is gitignored');
});
