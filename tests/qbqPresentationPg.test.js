/**
 * The presentation-edit migration and data access against a REAL PostgreSQL.
 *
 * Requires TEST_DATABASE_URL and SKIPS without it — a skipped test is not a
 * passing test. Each test gets a throwaway DATABASE (not a schema) so the
 * baseline schema.sql guards that look up constraints by name without a schema
 * filter behave exactly as they do in production.
 *
 * What only a real database can prove, and what this therefore covers:
 *   - migration 0005 applies on top of the real baseline and is idempotent;
 *   - the unique index is what makes saving an UPSERT rather than a duplicate;
 *   - a failed write leaves the previously saved row byte-for-byte intact.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const MIGRATIONS_DIR = path.resolve(__dirname, '../database/migrations');
const MIGRATION = fs.readFileSync(
  path.join(MIGRATIONS_DIR, '0005_qbq_presentation_edits.sql'),
  'utf8',
);
const SCHEMA = path.resolve(__dirname, '../database/schema.sql');

/** Every forward migration in apply order, exactly as a real boot runs them. */
function allMigrations() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort()
    .map((f) => ({ name: f, sql: fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8') }));
}
const POOL_PATH = require.resolve('../database/pool');

const skip = process.env.TEST_DATABASE_URL ? false : 'set TEST_DATABASE_URL';

/**
 * A throwaway UTF8 database with the real baseline + migration 0005 applied,
 * and database/qbqPresentation.js wired to it through the module cache.
 */
async function harness(t) {
  const name = `qbq_${crypto.randomBytes(6).toString('hex')}`;
  const adminUrl = process.env.TEST_DATABASE_URL;
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;

  const admin = new Pool({ connectionString: adminUrl });
  admin.on('error', () => {});
  // TEMPLATE template0 + UTF8: schema.sql contains box-drawing characters that
  // the Windows default (WIN1252) cannot store.
  await admin.query(`CREATE DATABASE ${name} WITH ENCODING 'UTF8' TEMPLATE template0`);

  const pool = new Pool({ connectionString: url.toString() });
  pool.on('error', () => {});
  await pool.query(fs.readFileSync(SCHEMA, 'utf8'));
  for (const migration of allMigrations()) {
    await pool.query(migration.sql);
  }

  const previous = require.cache[POOL_PATH];
  require.cache[POOL_PATH] = {
    id: POOL_PATH,
    filename: POOL_PATH,
    loaded: true,
    exports: { pool, query: (text, params) => pool.query(text, params) },
  };
  delete require.cache[require.resolve('../database/qbqPresentation')];
  const db = require('../database/qbqPresentation');

  t.after(async () => {
    delete require.cache[require.resolve('../database/qbqPresentation')];
    if (previous) require.cache[POOL_PATH] = previous;
    else delete require.cache[POOL_PATH];
    await pool.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  });

  return { pool, db };
}

test('migration 0005 is idempotent — applying it repeatedly is a no-op', { skip }, async (t) => {
  const { pool } = await harness(t);

  // Production re-runs the baseline on every boot; a migration must survive
  // being replayed without erroring or duplicating anything. The harness has
  // already applied the baseline plus every migration once — this is the
  // second and third full pass.
  await pool.query(fs.readFileSync(SCHEMA, 'utf8'));
  for (const migration of allMigrations()) {
    await pool.query(migration.sql);
  }
  await pool.query(MIGRATION);

  const columns = await pool.query(
    `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_name = 'qbq_presentation_edits'
      ORDER BY ordinal_position`,
  );
  assert.deepEqual(
    columns.rows.map((r) => r.column_name),
    ['id', 'deck_key', 'element_path', 'slide_index', 'content',
      'updated_by_admin_id', 'updated_at', 'created_at'],
  );

  const indexes = await pool.query(
    `SELECT indexname FROM pg_indexes
      WHERE tablename = 'qbq_presentation_edits' ORDER BY indexname`,
  );
  const names = indexes.rows.map((r) => r.indexname);
  assert.ok(names.includes('uq_qbq_presentation_edits_key_path'), 'unique index survives');
  assert.ok(names.includes('idx_qbq_presentation_edits_deck_slide'), 'lookup index survives');
  assert.equal(new Set(names).size, names.length, 'no duplicated index');
});

test('presentation edits are isolated from the SOS questionnaire tables', { skip }, async (t) => {
  const { pool } = await harness(t);
  const fks = await pool.query(
    `SELECT ccu.table_name AS referenced
       FROM information_schema.table_constraints tc
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
      WHERE tc.table_name = 'qbq_presentation_edits' AND tc.constraint_type = 'FOREIGN KEY'`,
  );
  const referenced = fks.rows.map((r) => r.referenced);
  assert.ok(!referenced.includes('sos_submissions'), 'no coupling to submissions');
  assert.ok(!referenced.includes('sos_settings'), 'no coupling to settings');

  // And the questionnaire tables still exist and are untouched by this feature.
  const sos = await pool.query(
    "SELECT to_regclass('public.sos_submissions') AS a, to_regclass('public.sos_settings') AS b",
  );
  assert.ok(sos.rows[0].a, 'sos_submissions still present');
  assert.ok(sos.rows[0].b, 'sos_settings still present');
});

test('saving is an UPSERT: one row per element, no matter how often it is saved', { skip }, async (t) => {
  const { pool, db } = await harness(t);

  await db.upsertOverride({ elementPath: 's12.1.0', slideIndex: 12, content: 'Birinchi', adminId: 7 });
  await db.upsertOverride({ elementPath: 's12.1.0', slideIndex: 12, content: 'Ikkinchi', adminId: 7 });
  await db.upsertOverride({ elementPath: 's12.1.0', slideIndex: 12, content: 'Uchinchi', adminId: 9 });

  const rows = await pool.query('SELECT * FROM qbq_presentation_edits WHERE element_path = $1', ['s12.1.0']);
  assert.equal(rows.rowCount, 1, 'three saves must leave exactly one row');
  assert.equal(rows.rows[0].content, 'Uchinchi', 'the latest text wins');
  assert.equal(rows.rows[0].updated_by_admin_id, 9, 'the latest author is recorded');

  const stored = await db.getOverride('s12.1.0');
  assert.equal(stored.content, 'Uchinchi');
  assert.equal(stored.slideIndex, 12);
});

test('the unique index actually prevents a duplicate row', { skip }, async (t) => {
  const { pool, db } = await harness(t);
  await db.upsertOverride({ elementPath: 's3.0', slideIndex: 3, content: 'Matn' });

  await assert.rejects(
    () => pool.query(
      `INSERT INTO qbq_presentation_edits (deck_key, element_path, slide_index, content)
       VALUES ('sos-offline-v2', 's3.0', 3, 'Boshqa')`,
    ),
    /duplicate key value|unique constraint/i,
    'a second row for the same element must be impossible at the database level',
  );
});

test('a failed save leaves the previously saved version exactly as it was', { skip }, async (t) => {
  const { pool, db } = await harness(t);
  const original = await db.upsertOverride({
    elementPath: 's5.2', slideIndex: 5, content: 'Saqlangan matn', adminId: 3,
  });

  // NOT NULL on content is the constraint a broken caller would hit.
  await assert.rejects(
    () => db.upsertOverride({ elementPath: 's5.2', slideIndex: 5, content: null, adminId: 4 }),
    /null value|not-null/i,
  );
  // An out-of-range slide index is another way a write can fail mid-flight.
  await assert.rejects(
    () => pool.query(
      `INSERT INTO qbq_presentation_edits (deck_key, element_path, slide_index, content)
       VALUES ('sos-offline-v2', 's5.2', 2147483648, 'X')`,
    ),
  );

  const after = await db.getOverride('s5.2');
  assert.equal(after.content, 'Saqlangan matn', 'text preserved');
  assert.equal(after.slideIndex, 5);
  assert.equal(after.updatedAt.getTime(), original.updatedAt.getTime(),
    'even the timestamp must be untouched by a failed save');

  const count = await pool.query('SELECT COUNT(*)::int AS n FROM qbq_presentation_edits');
  assert.equal(count.rows[0].n, 1, 'no orphan row from the failed writes');
});

test('overrides come back ordered by slide, and an unedited deck returns none', { skip }, async (t) => {
  const { db } = await harness(t);
  assert.deepEqual(await db.listOverrides(), [], 'an unedited deck must not error');

  for (const [elementPath, slideIndex] of [['s27.0', 27], ['s3.1', 3], ['s11.0.2', 11]]) {
    await db.upsertOverride({ elementPath, slideIndex, content: `Matn ${slideIndex}` });
  }
  const list = await db.listOverrides();
  assert.deepEqual(list.map((r) => r.slideIndex), [3, 11, 27]);
  assert.deepEqual(list.map((r) => r.elementPath), ['s3.1', 's11.0.2', 's27.0']);
});

test('a different deck_key is a separate namespace', { skip }, async (t) => {
  const { db } = await harness(t);
  await db.upsertOverride({ elementPath: 's1.0', slideIndex: 1, content: 'Asosiy' });
  await db.upsertOverride({ elementPath: 's1.0', slideIndex: 1, content: 'Boshqa', deckKey: 'other-deck' });

  assert.equal((await db.getOverride('s1.0')).content, 'Asosiy');
  assert.equal((await db.getOverride('s1.0', 'other-deck')).content, 'Boshqa');
  assert.equal((await db.listOverrides()).length, 1, 'decks do not leak into each other');
});

test('Uzbek text with apostrophes and newlines round-trips exactly', { skip }, async (t) => {
  const { db } = await harness(t);
  const text = 'Ikki oy o‘tib, Jeykob lavozimga ko‘tarildi.\nQat’i nazar — “savol” ortidagi savol.';
  await db.upsertOverride({ elementPath: 's12.1.0', slideIndex: 12, content: text });
  assert.equal((await db.getOverride('s12.1.0')).content, text);
});
