/**
 * GUARD — automatic trailer creation must never come back.
 *
 * `trailers` is the single authoritative master list. A trailer may join it
 * ONLY through an approved master-list import or explicit, permission-gated
 * manual creation. A Telegram message or an AI detection must NEVER create one;
 * an unknown unit number becomes an unmatched-mention review record instead.
 *
 * Three layers of protection:
 *
 *  1. A static scan enumerating every `INSERT INTO trailers` site in the data
 *     access layer. Adding a new one fails this test on purpose. Update
 *     KNOWN_CREATION_SITES only with a deliberate, reviewed decision.
 *  2. A static scan asserting `telegram_detected` can no longer be written.
 *  3. Behavioral tests: detection resolves, and creation refuses an
 *     illegitimate source at the DATA LAYER — not merely at a route check.
 *
 * These assertions previously documented the opposite (a detection creating a
 * stub trailer). They were inverted when master-list authority landed.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const POOL_PATH = require.resolve('../database/pool');
const DATABASE_DIR = path.resolve(__dirname, '../database');

/**
 * The complete, intentional set of trailer-creation sites, keyed by file.
 *
 *   trailerMasterList/masterTrailers.js
 *       upsertTrailerByUnitNumber — manual creation / approved import only;
 *       it throws for any other source.
 *   trailerAssets.js
 *       createDepartmentTrailer — permission-gated manual creation.
 *   trailerMasterList/reconciliation.js
 *       createApproved — a trailer explicitly approved by a reviewer from the
 *       "new" group of a confirmed master-list snapshot, inside the
 *       reconciliation transaction.
 *
 * Each is a human deciding to add a trailer. There is deliberately NO
 * detection-driven creation path.
 */
const KNOWN_CREATION_SITES = {
  'trailerMasterList/masterTrailers.js': 1,
  'trailerMasterList/reconciliation.js': 1,
  'trailerAssets.js': 1,
};

/**
 * Strip comments so prose can never be mistaken for code. Without this, a doc
 * comment merely *mentioning* an insert would be counted as one — the scan
 * would then be satisfied by wording rather than by behavior.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments, including JSDoc
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 '); // line comments, sparing URLs
}

/** Count real `INSERT INTO trailers` statements, ignoring trailer_* child tables. */
function countTrailerInserts(source) {
  const matches = stripComments(source).match(/INSERT\s+INTO\s+trailers\b(?!_)/gi);
  return matches ? matches.length : 0;
}

/** Every .js file under database/, recursively (the master-list package nests). */
function databaseFiles(dir = DATABASE_DIR) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...databaseFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('no unreviewed code path inserts into the trailers master list', () => {
  const found = {};
  for (const file of databaseFiles()) {
    const count = countTrailerInserts(fs.readFileSync(file, 'utf8'));
    if (count > 0) found[path.relative(DATABASE_DIR, file).split(path.sep).join('/')] = count;
  }
  assert.deepEqual(
    found,
    KNOWN_CREATION_SITES,
    'A trailer-creation site was added, moved, or removed. Creation is allowed ONLY from an approved '
    + 'import or permission-gated manual creation — never from Telegram or AI detection.',
  );
});

test('no code path can write a telegram_detected trailer', () => {
  const offenders = [];
  for (const file of databaseFiles()) {
    const source = stripComments(fs.readFileSync(file, 'utf8'));
    const insertBlocks = source.match(/INSERT\s+INTO\s+trailers\b(?!_)[\s\S]{0,400}/gi) || [];
    if (insertBlocks.some((block) => block.includes("'telegram_detected'"))) {
      offenders.push(path.relative(DATABASE_DIR, file).split(path.sep).join('/'));
    }
  }
  assert.deepEqual(offenders, [], 'A detection-sourced trailer insert was reintroduced.');
});

/**
 * Load database/trailers.js with its pool stubbed, capturing issued SQL.
 * The whole database/ tree is purged first: trailers.js pulls in the
 * master-list resolver, which would otherwise stay bound to the real pool.
 */
function loadTrailersWithCapturedSql(rowsFor) {
  const statements = [];
  const purge = () => {
    for (const file of databaseFiles()) delete require.cache[file];
    delete require.cache[POOL_PATH];
  };
  purge();
  require.cache[POOL_PATH] = {
    id: POOL_PATH,
    filename: POOL_PATH,
    loaded: true,
    exports: {
      query: async (text, values) => {
        statements.push({ text, values });
        return { rows: rowsFor(text, values) || [] };
      },
    },
  };
  try {
    return { trailers: require('../database/trailers'), statements };
  } finally {
    purge();
  }
}

const isSelect = (text) => /^\s*SELECT/i.test(text);
const isTrailerInsert = (text) => /INSERT\s+INTO\s+trailers\b(?!_)/i.test(text);

test('an unknown detected unit number resolves to nothing and creates no trailer', async () => {
  // Neither the unit-number lookup nor the alias lookup finds anything.
  const { trailers, statements } = loadTrailersWithCapturedSql(() => []);

  const resolved = await trailers.ensureTrailerForDetection('T-900');

  assert.equal(resolved, null, 'the caller must queue an unmatched mention, not get a trailer');
  assert.equal(
    statements.filter((s) => isTrailerInsert(s.text)).length,
    0,
    'a Telegram detection must NEVER insert into the master list',
  );
});

test('a known trailer resolves by unit number without any insert', async () => {
  const existing = { id: 3, unit_number: 'T-100', master_status: 'active', is_official: true };
  const { trailers, statements } = loadTrailersWithCapturedSql((text) => (isSelect(text) ? [existing] : []));

  const resolved = await trailers.ensureTrailerForDetection('T-100');

  assert.equal(resolved.id, 3, 'known trailers still resolve — detection for them is unchanged');
  assert.equal(statements.filter((s) => isTrailerInsert(s.text)).length, 0);
});

test('a detected number resolves through an active alias', async () => {
  const canonical = { id: 9, unit_number: 'T-777', master_status: 'active', is_official: true };
  const { trailers } = loadTrailersWithCapturedSql((text) => {
    if (/FROM trailer_aliases/i.test(text)) return [canonical];
    return []; // no direct unit-number match
  });

  const resolved = await trailers.ensureTrailerForDetection('T-OLD-777');

  assert.equal(resolved.id, 9, 'an alias identifies the surviving canonical trailer');
});

test('a blank detected unit number resolves to nothing and never touches the database', async () => {
  for (const blank of [null, undefined, '', '   ', '#']) {
    const { trailers, statements } = loadTrailersWithCapturedSql(() => []);
    assert.equal(await trailers.ensureTrailerForDetection(blank), null);
    assert.equal(statements.length, 0, `"${blank}" must not query at all`);
  }
});

test('detected unit numbers are normalized before lookup', async () => {
  const { trailers, statements } = loadTrailersWithCapturedSql((text) => (
    isSelect(text) && !/trailer_aliases/i.test(text) ? [{ id: 1, unit_number: 'T-100' }] : []
  ));

  await trailers.ensureTrailerForDetection('  #t-100  ');

  const lookup = statements.find((s) => isSelect(s.text));
  assert.deepEqual(lookup.values, ['T-100'], 'case, hashes and whitespace are normalized away');
});

// ─── data-layer creation enforcement ───

test('creating a trailer from a detection source is refused by the data layer', async () => {
  const { trailers, statements } = loadTrailersWithCapturedSql(() => []); // no existing trailer

  await assert.rejects(
    () => trailers.upsertTrailerByUnitNumber({ unit_number: 'T-901', source: 'telegram_detected' }),
    (error) => {
      assert.equal(error.code, 'TRAILER_NOT_IN_MASTER_LIST');
      assert.equal(error.status, 422);
      assert.match(error.message, /master list/i);
      return true;
    },
  );
  assert.equal(
    statements.filter((s) => isTrailerInsert(s.text)).length,
    0,
    'the insert is refused before it is ever issued',
  );
});

test('manual creation records admin_manual as the master source', async () => {
  const { trailers, statements } = loadTrailersWithCapturedSql((text) => (
    isTrailerInsert(text) ? [{ id: 5 }] : []
  ));

  await trailers.upsertTrailerByUnitNumber({ unit_number: 'T-902', source: 'admin_manual' });

  const insert = statements.find((s) => isTrailerInsert(s.text));
  assert.ok(insert, 'manual creation is allowed');
  assert.ok(insert.values.includes('admin_manual'));
  assert.ok(insert.values.includes('active'), 'a manually created trailer is official immediately');
});

test('legacy screenshot_import can no longer create through the general upsert', async () => {
  // The bypass: commitRows used to upsert with source 'screenshot_import',
  // minting official trailers with no reconciliation. That source is no longer
  // a creation authority on the general write path — approved-import trailers
  // are created only inside the reconciliation transaction (createApproved).
  const { trailers, statements } = loadTrailersWithCapturedSql((text) => (
    isSelect(text) ? [] : [{ id: 6 }]
  ));

  await assert.rejects(
    () => trailers.upsertTrailerByUnitNumber({ unit_number: 'T-903', source: 'screenshot_import' }),
    (err) => err.code === 'TRAILER_NOT_IN_MASTER_LIST',
    'legacy screenshot import must not mint an official trailer via upsert',
  );
  assert.equal(
    statements.filter((s) => isTrailerInsert(s.text)).length,
    0,
    'no INSERT is attempted for a blocked legacy import source',
  );
});

test('updating an existing trailer is never blocked by the creation guard', async () => {
  const existing = { id: 4, unit_number: 'T-100', source: 'telegram_detected' };
  const { trailers, statements } = loadTrailersWithCapturedSql((text) => (
    isSelect(text) ? [existing] : [{ ...existing, make: 'Utility' }]
  ));

  // A legacy telegram_detected trailer must remain editable — its history is
  // real even though it is pending master review.
  const updated = await trailers.upsertTrailerByUnitNumber({ unit_number: 'T-100', make: 'Utility' });

  assert.equal(updated.make, 'Utility');
  assert.equal(statements.filter((s) => isTrailerInsert(s.text)).length, 0, 'an update is not a create');
});

test('optimistic locking: an update always bumps version', async () => {
  const existing = { id: 4, unit_number: 'T-100', source: 'admin_manual', version: 2 };
  const { trailers, statements } = loadTrailersWithCapturedSql((text) => (
    isSelect(text) ? [existing] : [{ ...existing, make: 'Utility', version: 3 }]
  ));
  await trailers.upsertTrailerByUnitNumber({ unit_number: 'T-100', make: 'Utility' });
  const update = statements.find((s) => /UPDATE\s+trailers/i.test(s.text));
  assert.ok(update, 'an UPDATE ran');
  assert.match(update.text, /version = version \+ 1/, 'the update bumps the version');
});

test('optimistic locking: a stale version raises 409 and overwrites nothing', async () => {
  const existing = { id: 4, unit_number: 'T-100', source: 'admin_manual', version: 5 };
  // Simulate the guarded UPDATE affecting no row (someone else already bumped it).
  const { trailers } = loadTrailersWithCapturedSql((text) => (isSelect(text) ? [existing] : []));
  await assert.rejects(
    () => trailers.upsertTrailerByUnitNumber({ unit_number: 'T-100', make: 'Utility', version: 3 }),
    (err) => err.status === 409 && err.code === 'VERSION_CONFLICT',
  );
});
