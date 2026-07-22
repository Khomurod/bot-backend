/**
 * Scaffold a new forward migration file.
 *
 *   npm run migrate:new -- add_widget_flags
 *   node scripts/create-migration.js add_widget_flags --kind backfill --no-transaction
 *
 * Picks the next zero-padded version by scanning database/migrations/ and writes
 * a template file. Does not touch the database.
 */
const fs = require('node:fs');
const path = require('node:path');
const { loadMigrations, MIGRATIONS_DIR } = require('../database/migrate');

function slugify(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function nextVersion() {
  const existing = loadMigrations(MIGRATIONS_DIR);
  if (!existing.length) return '0001';
  const max = Math.max(...existing.map((m) => Number(m.version)));
  return String(max + 1).padStart(4, '0');
}

(function main() {
  const args = process.argv.slice(2);
  const positionals = args.filter((a) => !a.startsWith('--'));
  const name = slugify(positionals[0]);
  if (!name) {
    console.error('Usage: node scripts/create-migration.js <description> [--kind schema|seed|backfill] [--no-transaction]');
    process.exit(1);
  }

  const kindIdx = args.indexOf('--kind');
  const kind = kindIdx >= 0 ? args[kindIdx + 1] : 'schema';
  if (!['schema', 'seed', 'backfill'].includes(kind)) {
    console.error(`Invalid --kind "${kind}". Use schema, seed, or backfill.`);
    process.exit(1);
  }
  const noTxn = args.includes('--no-transaction');

  const version = nextVersion();
  const filename = `${version}_${name}.sql`;
  const filepath = path.join(MIGRATIONS_DIR, filename);
  if (fs.existsSync(filepath)) {
    console.error(`Refusing to overwrite existing ${filename}.`);
    process.exit(1);
  }

  const header = [
    `-- Migration ${version}: ${name.replace(/_/g, ' ')}`,
    `-- migrate:kind: ${kind}`,
    noTxn ? '-- migrate:no-transaction' : null,
    '--',
    '-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the',
    '-- full diff before pushing — this repo can auto-deploy. See',
    '-- database/migrations/README.md.',
    '',
    '',
  ].filter((l) => l !== null).join('\n');

  fs.mkdirSync(MIGRATIONS_DIR, { recursive: true });
  fs.writeFileSync(filepath, header, 'utf8');
  console.log(`Created database/migrations/${filename}`);
})();
