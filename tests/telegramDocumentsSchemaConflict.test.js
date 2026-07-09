/**
 * REGRESSION TEST for the silent BOL/POD monitor "nothing happens" bug.
 *
 * Root cause: database/telegramDocuments.js `addFileToBatch()` used
 *   ON CONFLICT (telegram_file_unique_id) DO NOTHING
 * but database/schema.sql defines the dedup guard as a PARTIAL unique index:
 *   CREATE UNIQUE INDEX idx_tg_doc_files_unique_id
 *     ON telegram_document_files(telegram_file_unique_id)
 *     WHERE telegram_file_unique_id IS NOT NULL;
 *
 * Postgres will NOT infer a partial index from a bare column list, so that
 * INSERT raises at runtime:
 *   "there is no unique or exclusion constraint matching the ON CONFLICT
 *    specification"
 * The handler (bot/documentIntakeHandlers.js) catches it, returns early, and
 * never schedules finalizeBatch() — so classification, load matching, and the
 * test-group report NEVER run. That is exactly the reported failure.
 *
 * Why the existing tests/telegramDocuments.test.js did NOT catch it: those tests
 * replace `pg` with a hand-written in-memory emulator that special-cases the
 * INSERT by string and never models Postgres's ON CONFLICT arbiter-inference
 * rules — so any ON CONFLICT variant "passes" there.
 *
 * This test instead reads BOTH real artifacts — the exact SQL `addFileToBatch()`
 * runs AND the real schema.sql index definitions — and applies the same
 * arbiter-inference rule Postgres uses. It fails on the old code and passes on
 * the fix (`ON CONFLICT DO NOTHING`), with no live database required (so it runs
 * anywhere `node --test` runs, including CI without DATABASE_URL).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_PATH = path.resolve(__dirname, '../database/schema.sql');
const TABLE = 'telegram_document_files';

/** Capture the exact SQL `addFileToBatch()` sends to the pg layer. */
function captureAddFileSql() {
  let captured = null;
  async function query(text) {
    captured = String(text);
    return { rows: [{ id: 1 }], rowCount: 1 };
  }
  const modPath = path.resolve(__dirname, '../database/telegramDocuments.js');
  const dbPath = path.resolve(__dirname, '../database/db.js');
  delete require.cache[modPath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { query } };
  const docs = require(modPath);
  return docs.addFileToBatch(1, { telegramFileUniqueId: 'AQADabc', kind: 'pdf' }).then(() => {
    delete require.cache[dbPath];
    return captured;
  });
}

/** Parse `INSERT INTO <table> ... ON CONFLICT ...` — the arbiter specification. */
function parseOnConflict(sql) {
  const flat = sql.replace(/\s+/g, ' ').trim();
  const m = /ON CONFLICT\b(.*?)\bDO\b/i.exec(flat);
  if (!m) return { present: false };
  const spec = m[1].trim(); // between "ON CONFLICT" and "DO"
  if (spec === '') return { present: true, targeted: false }; // bare: matches any unique constraint
  const onConstraint = /^ON CONSTRAINT\s+(\w+)/i.exec(spec);
  if (onConstraint) return { present: true, targeted: true, constraint: onConstraint[1] };
  const cols = /^\(([^)]*)\)/.exec(spec);
  const columns = cols ? cols[1].split(',').map((c) => c.trim().toLowerCase()).filter(Boolean) : [];
  const where = /\bWHERE\b(.+)$/i.exec(spec);
  return {
    present: true,
    targeted: true,
    columns,
    hasWhere: Boolean(where),
    wherePredicate: where ? where[1].trim() : null,
  };
}

/** Extract every UNIQUE index defined on `table` in schema.sql. */
function parseUniqueIndexes(schema, table) {
  const flat = schema.replace(/\s+/g, ' ');
  const re = new RegExp(
    `CREATE UNIQUE INDEX(?: IF NOT EXISTS)?\\s+(\\w+)\\s+ON\\s+${table}\\s*\\(([^)]*)\\)([^;]*);`,
    'gi'
  );
  const indexes = [];
  let m;
  while ((m = re.exec(flat)) !== null) {
    const columns = m[2].split(',').map((c) => c.trim().replace(/\s+(asc|desc)$/i, '').toLowerCase()).filter(Boolean);
    const tail = m[3] || '';
    const where = /\bWHERE\b(.+)$/i.exec(tail);
    indexes.push({
      name: m[1],
      columns,
      partial: Boolean(where),
      wherePredicate: where ? where[1].trim().replace(/\s*$/, '') : null,
    });
  }
  return indexes;
}

/**
 * Replicate Postgres's ON CONFLICT arbiter inference:
 *  - A bare `ON CONFLICT DO ...` (no target) always has an arbiter (any unique
 *    constraint on the row), so it never raises the "no matching constraint"
 *    error.
 *  - A targeted `ON CONFLICT (cols)` requires a unique index on EXACTLY those
 *    columns; if that index is PARTIAL, the statement must repeat its predicate
 *    via `ON CONFLICT (cols) WHERE <predicate>`. A bare column list can NOT
 *    infer a partial index.
 * Returns { ok, reason }.
 */
function canInferArbiter(onConflict, uniqueIndexes) {
  if (!onConflict.present) return { ok: true, reason: 'no ON CONFLICT clause' };
  if (!onConflict.targeted) return { ok: true, reason: 'untargeted ON CONFLICT matches any unique constraint' };
  if (onConflict.constraint) return { ok: true, reason: `named constraint ${onConflict.constraint}` };

  const target = (onConflict.columns || []).slice().sort().join(',');
  const candidates = uniqueIndexes.filter((ix) => ix.columns.slice().sort().join(',') === target);
  if (!candidates.length) {
    return { ok: false, reason: `no unique index on (${target}) at all` };
  }
  // A non-partial index on the exact columns is always inferable.
  if (candidates.some((ix) => !ix.partial)) {
    return { ok: true, reason: `non-partial unique index on (${target})` };
  }
  // Only partial indexes exist → the ON CONFLICT must repeat the predicate.
  if (!onConflict.hasWhere) {
    return {
      ok: false,
      reason: `only PARTIAL unique index (${candidates[0].name}) on (${target}); `
        + 'ON CONFLICT gives a bare column list with no WHERE, which Postgres cannot infer',
    };
  }
  return { ok: true, reason: 'ON CONFLICT repeats the partial index predicate' };
}

test('addFileToBatch ON CONFLICT is inferable against the real schema.sql partial index', async () => {
  const sql = await captureAddFileSql();
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');

  const uniqueIndexes = parseUniqueIndexes(schema, TABLE);
  // Sanity: the schema must actually contain the dedup guard we depend on.
  const uniqueOnGuard = uniqueIndexes.find((ix) => ix.columns.join(',') === 'telegram_file_unique_id');
  assert.ok(uniqueOnGuard, 'schema.sql must define a unique index on telegram_file_unique_id');
  assert.ok(uniqueOnGuard.partial, 'the dedup index is expected to be PARTIAL (WHERE ... IS NOT NULL)');

  const onConflict = parseOnConflict(sql);
  assert.ok(onConflict.present, 'addFileToBatch must keep an ON CONFLICT clause (duplicate protection)');

  const verdict = canInferArbiter(onConflict, uniqueIndexes);
  assert.ok(
    verdict.ok,
    `addFileToBatch would raise "no unique or exclusion constraint matching the ON CONFLICT specification" — ${verdict.reason}`
  );
});

test('addFileToBatch still swallows duplicates (DO NOTHING, not DO UPDATE) — dedup preserved', async () => {
  const sql = await captureAddFileSql();
  const flat = sql.replace(/\s+/g, ' ');
  assert.match(flat, /ON CONFLICT[\s\S]*DO NOTHING/i, 'a resent/echoed file must be dropped, never duplicated or upserted');
});

test('the OLD buggy form (bare column target on a partial index) is proven un-inferable', () => {
  // Guards the guard: if the arbiter model ever regressed to always returning ok,
  // this reproduces the exact original defect and asserts the model flags it.
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const uniqueIndexes = parseUniqueIndexes(schema, TABLE);
  const buggy = parseOnConflict(
    'INSERT INTO telegram_document_files (telegram_file_unique_id) VALUES ($1) '
    + 'ON CONFLICT (telegram_file_unique_id) DO NOTHING RETURNING *'
  );
  const verdict = canInferArbiter(buggy, uniqueIndexes);
  assert.equal(verdict.ok, false, 'the original ON CONFLICT (telegram_file_unique_id) must be detected as un-inferable');
});
