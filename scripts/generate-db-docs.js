#!/usr/bin/env node
/**
 * generate-db-docs.js  →  `npm run db:docs`
 *
 * Introspects the live PostgreSQL database (DATABASE_URL) and regenerates the
 * durable database documentation under docs/database/:
 *   - schema-current.md   human-readable per-table reference (columns, keys,
 *                         indexes, constraints, purpose, lifecycle status)
 *   - schema-current.sql  a structural SQL snapshot rebuilt from the catalog
 *                         (CREATE TABLE + constraints + indexes; NO row data)
 *   - relationships.md    the foreign-key graph
 *
 * SAFETY:
 *   - Read-only. Runs only SELECTs against system catalogs / information_schema.
 *   - NEVER prints or writes the DATABASE_URL (only a masked host).
 *   - NEVER reads or emits row CONTENTS — structure only. No counts either, so
 *     the docs stay deterministic and leak nothing about data/scale.
 *
 * Curated, human-authored context (purpose / lifecycle status / owning service /
 * danger notes) lives in docs/database/table-metadata.json and is merged in.
 * Tables absent from that file are documented from structure alone.
 *
 * If DATABASE_URL is not set the script exits with a clear error (pass
 * --from-schema to instead render a limited doc set from database/schema.sql,
 * with a prominent warning that it is not introspected from a live DB).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DOCS_DIR = path.join(ROOT, 'docs', 'database');
const METADATA_FILE = path.join(DOCS_DIR, 'table-metadata.json');
const SCHEMA_SQL = path.join(ROOT, 'database', 'schema.sql');

function maskDbUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.username ? '***@' : ''}${u.hostname}:${u.port || ''}${u.pathname}`;
  } catch (_) {
    return '(unparseable url — masked)';
  }
}

function deriveSsl(url) {
  if (!url) return false;
  if (/localhost|127\.0\.0\.1/.test(url)) return false;
  if (/sslmode=require/.test(url) || url.includes('supabase') || url.includes('neon')) {
    return { rejectUnauthorized: false };
  }
  return false;
}

function loadMetadata() {
  try {
    return JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8'));
  } catch (_) {
    return { tables: {} };
  }
}

// Pull a one-line purpose for a table from the `-- TABLE: name — ...` banner
// comments in schema.sql, as a fallback when no curated purpose exists.
function purposesFromSchemaSql() {
  const out = {};
  let text = '';
  try { text = fs.readFileSync(SCHEMA_SQL, 'utf8'); } catch (_) { return out; }
  const re = /--\s*TABLE:\s*([a-z0-9_]+)\s*[—-]\s*(.+)/gi;
  let m;
  while ((m = re.exec(text))) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

async function introspect(client) {
  // Base tables in the public schema (exclude views).
  const tablesRes = await client.query(`
    SELECT c.relname AS name, obj_description(c.oid) AS comment
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY c.relname`);

  const tables = [];
  for (const t of tablesRes.rows) {
    const cols = await client.query(`
      SELECT a.attname AS name,
             format_type(a.atttypid, a.atttypmod) AS type,
             a.attnotnull AS not_null,
             pg_get_expr(d.adbin, d.adrelid) AS default_expr,
             col_description(a.attrelid, a.attnum) AS comment
        FROM pg_attribute a
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`, [`public."${t.name}"`]);

    const cons = await client.query(`
      SELECT conname AS name, contype AS type, pg_get_constraintdef(oid) AS def
        FROM pg_constraint
       WHERE conrelid = $1::regclass
       ORDER BY contype, conname`, [`public."${t.name}"`]);

    const idx = await client.query(`
      SELECT indexname AS name, indexdef AS def
        FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = $1
       ORDER BY indexname`, [t.name]);

    tables.push({ name: t.name, comment: t.comment, columns: cols.rows, constraints: cons.rows, indexes: idx.rows });
  }

  // Foreign-key graph (child → parent).
  const fks = await client.query(`
    SELECT tc.table_name AS child,
           kcu.column_name AS child_col,
           ccu.table_name AS parent,
           ccu.column_name AS parent_col,
           rc.delete_rule AS on_delete
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
      JOIN information_schema.referential_constraints rc
        ON rc.constraint_name = tc.constraint_name
     WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
     ORDER BY tc.table_name, kcu.column_name`);

  return { tables, fks: fks.rows };
}

const CONTYPE_LABEL = { p: 'Primary key', f: 'Foreign key', u: 'Unique', c: 'Check', x: 'Exclusion' };

function renderColumn(c) {
  const nn = c.not_null ? 'NOT NULL' : 'null';
  const def = c.default_expr ? ` default \`${c.default_expr}\`` : '';
  const comment = c.comment ? ` — ${c.comment.replace(/\|/g, '\\|')}` : '';
  return `| \`${c.name}\` | \`${c.type}\` | ${nn}${def} |${comment ? comment.replace(/^ — /, ' ') : ''}`;
}

function statusBadge(status) {
  const s = String(status || 'active').toLowerCase();
  const emoji = { active: '🟢', legacy: '🟡', retired: '🔴', historical: '🔵' }[s] || '⚪';
  return `${emoji} ${s}`;
}

function renderMarkdown({ tables, fks }, meta, schemaPurposes, generatedNote) {
  const tmeta = meta.tables || {};
  const lines = [];
  lines.push('# Database — Current Schema (generated)');
  lines.push('');
  lines.push('> **Do not edit by hand.** Regenerate with `npm run db:docs` (see');
  lines.push('> `docs/database/README.md`). Every schema-changing PR must re-run it.');
  lines.push('');
  lines.push(generatedNote);
  lines.push('');
  lines.push(`**Tables:** ${tables.length}`);
  lines.push('');

  // Index / table of contents.
  lines.push('## Tables');
  lines.push('');
  for (const t of tables) {
    const m = tmeta[t.name] || {};
    const purpose = m.purpose || schemaPurposes[t.name] || '';
    lines.push(`- [\`${t.name}\`](#${t.name}) — ${statusBadge(m.status)}${purpose ? ` — ${purpose}` : ''}`);
  }
  lines.push('');

  for (const t of tables) {
    const m = tmeta[t.name] || {};
    const purpose = m.purpose || schemaPurposes[t.name] || t.comment || '_No description recorded._';
    lines.push(`## ${t.name}`);
    lines.push('');
    lines.push(`- **Status:** ${statusBadge(m.status)}`);
    if (m.service) lines.push(`- **Used by:** ${m.service}`);
    if (m.sourceOfTruth) lines.push(`- **Source of truth:** ${m.sourceOfTruth}`);
    lines.push(`- **Purpose:** ${purpose}`);
    if (m.danger) lines.push(`- **⚠️ Data-safety note:** ${m.danger}`);
    lines.push('');
    lines.push('| Column | Type | Nullability |');
    lines.push('|---|---|---|');
    for (const c of t.columns) lines.push(renderColumn(c));
    lines.push('');

    const byType = (type) => t.constraints.filter((c) => c.type === type);
    const pk = byType('p');
    const fk = byType('f');
    const uq = byType('u');
    const ck = byType('c');
    if (pk.length) lines.push(`- **${CONTYPE_LABEL.p}:** ${pk.map((c) => `\`${c.def}\``).join(', ')}`);
    if (fk.length) {
      lines.push('- **Foreign keys:**');
      for (const c of fk) lines.push(`  - \`${c.def}\``);
    }
    if (uq.length) {
      lines.push('- **Unique:**');
      for (const c of uq) lines.push(`  - \`${c.def}\``);
    }
    if (ck.length) {
      lines.push('- **Checks:**');
      for (const c of ck) lines.push(`  - \`${c.def}\``);
    }
    // Non-constraint indexes only (skip indexes that back a constraint).
    const conNames = new Set(t.constraints.map((c) => c.name));
    const plainIdx = t.indexes.filter((i) => !conNames.has(i.name));
    if (plainIdx.length) {
      lines.push('- **Indexes:**');
      for (const i of plainIdx) lines.push(`  - \`${i.def}\``);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function renderRelationships({ fks }) {
  const lines = [];
  lines.push('# Database — Relationships (generated)');
  lines.push('');
  lines.push('> Regenerate with `npm run db:docs`. Foreign keys only (child → parent).');
  lines.push('');
  lines.push('| Child table | Column | → | Parent table | Column | ON DELETE |');
  lines.push('|---|---|---|---|---|---|');
  for (const f of fks) {
    lines.push(`| \`${f.child}\` | \`${f.child_col}\` | → | \`${f.parent}\` | \`${f.parent_col}\` | ${f.on_delete} |`);
  }
  lines.push('');
  lines.push(`_Total foreign keys: ${fks.length}_`);
  lines.push('');
  return lines.join('\n');
}

function renderSql({ tables }, generatedNote) {
  const out = [];
  out.push('-- Structural schema snapshot (generated by npm run db:docs).');
  out.push('-- Rebuilt from the live catalog: CREATE TABLE + constraints + indexes.');
  out.push('-- Contains NO row data. Do not edit by hand.');
  out.push(`-- ${generatedNote}`);
  out.push('');
  // Emitted in three passes so the file loads cleanly in order: all tables
  // first, then constraints (FKs can reference any table), then indexes.
  out.push('-- ── Tables ──────────────────────────────────────────────────────────');
  for (const t of tables) {
    out.push(`CREATE TABLE ${t.name} (`);
    const colLines = t.columns.map((c) => {
      // Re-collapse `integer DEFAULT nextval('..._seq')` back to SERIAL/BIGSERIAL
      // so the snapshot is self-contained (the sequence is created implicitly)
      // and readable.
      if (c.default_expr && /^nextval\('/.test(c.default_expr)) {
        const serial = c.type === 'bigint' ? 'bigserial'
          : (c.type === 'smallint' ? 'smallserial' : 'serial');
        return `  ${c.name} ${serial}${c.not_null ? ' NOT NULL' : ''}`;
      }
      let line = `  ${c.name} ${c.type}`;
      if (c.default_expr) line += ` DEFAULT ${c.default_expr}`;
      if (c.not_null) line += ' NOT NULL';
      return line;
    });
    out.push(colLines.join(',\n'));
    out.push(');');
    out.push('');
  }
  out.push('-- ── Keys/uniques/checks (added before FKs so FK targets exist) ──────');
  for (const t of tables) {
    for (const c of t.constraints) {
      if (c.type !== 'f') out.push(`ALTER TABLE ${t.name} ADD CONSTRAINT ${c.name} ${c.def};`);
    }
  }
  out.push('');
  out.push('-- ── Foreign keys ────────────────────────────────────────────────────');
  for (const t of tables) {
    for (const c of t.constraints) {
      if (c.type === 'f') out.push(`ALTER TABLE ${t.name} ADD CONSTRAINT ${c.name} ${c.def};`);
    }
  }
  out.push('');
  out.push('-- ── Indexes (non-constraint) ────────────────────────────────────────');
  for (const t of tables) {
    const conNames = new Set(t.constraints.map((c) => c.name));
    for (const i of t.indexes) {
      if (!conNames.has(i.name)) out.push(`${i.def};`);
    }
  }
  out.push('');
  return out.join('\n');
}

async function main() {
  const fromSchemaOnly = process.argv.includes('--from-schema');
  const url = process.env.DATABASE_URL;

  fs.mkdirSync(DOCS_DIR, { recursive: true });
  const meta = loadMetadata();
  const schemaPurposes = purposesFromSchemaSql();

  if (!url) {
    if (!fromSchemaOnly) {
      console.error('[db:docs] ERROR: DATABASE_URL is not set.');
      console.error('[db:docs] Set DATABASE_URL to introspect the live DB, or pass --from-schema');
      console.error('[db:docs] to render a limited doc set from database/schema.sql (not live-verified).');
      process.exit(1);
    }
    console.warn('[db:docs] WARNING: no DATABASE_URL — generating limited docs from database/schema.sql.');
    console.warn('[db:docs] These are NOT introspected from a live database. Re-run with DATABASE_URL set.');
    // Minimal fallback: list the tables + purposes parsed from schema.sql.
    const names = Object.keys(schemaPurposes).sort();
    const body = ['# Database — Schema (from schema.sql, NOT live-introspected)', '',
      '> ⚠️ Generated without a live DATABASE_URL. Re-run `npm run db:docs` with',
      '> DATABASE_URL set for the authoritative, introspected documentation.', '',
      ...names.map((n) => `- \`${n}\` — ${schemaPurposes[n]}`), ''].join('\n');
    fs.writeFileSync(path.join(DOCS_DIR, 'schema-current.md'), body);
    console.log(`[db:docs] Wrote limited docs/database/schema-current.md (${names.length} tables from schema.sql).`);
    return;
  }

  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, ssl: deriveSsl(url), max: 2 });
  console.log(`[db:docs] Connecting to ${maskDbUrl(url)} …`);
  const client = await pool.connect();
  let introspected;
  try {
    introspected = await introspect(client);
  } finally {
    client.release();
    await pool.end();
  }

  const generatedNote = `Generated from an introspected database (${introspected.tables.length} tables). Structure only — no row data.`;

  fs.writeFileSync(path.join(DOCS_DIR, 'schema-current.md'), renderMarkdown(introspected, meta, schemaPurposes, generatedNote) + '\n');
  fs.writeFileSync(path.join(DOCS_DIR, 'relationships.md'), renderRelationships(introspected) + '\n');
  fs.writeFileSync(path.join(DOCS_DIR, 'schema-current.sql'), renderSql(introspected, generatedNote) + '\n');

  console.log(`[db:docs] Wrote docs/database/schema-current.md, relationships.md, schema-current.sql`);
  console.log(`[db:docs] Tables: ${introspected.tables.length}, foreign keys: ${introspected.fks.length}`);
}

main().catch((err) => {
  console.error('[db:docs] FAILED:', err.message);
  process.exit(1);
});
