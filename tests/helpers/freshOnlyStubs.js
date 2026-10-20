'use strict';

/**
 * The boot baseline as a DEPLOYED database runs it.
 *
 * A few retired tables are still created by the baseline, but only inside a
 * `DO $$ … $$` block guarded by `to_regclass('public.schema_migrations') IS
 * NULL` — on a brand-new database, before any migration has run, so that an
 * old migration which still alters the table can run there. On a deployed
 * database the ledger exists and those blocks do nothing.
 *
 * Tests that ask "does the boot baseline recreate this table?" must therefore
 * look at the schema WITHOUT those blocks, and separately prove that every such
 * block really carries the guard.
 */
const FRESH_ONLY_GUARD = "to_regclass('public.schema_migrations') IS NULL";

/**
 * The blocks that run only on a brand-new database: for each occurrence of the
 * guard, the nearest `DO $$` before it through the first `END $$;` after it.
 * (A plain non-greedy `DO $$ … END $$;` scan is not safe here — some older
 * blocks end differently, and the scan would run one block into the next.)
 */
function freshOnlyBlocks(schema) {
  const text = String(schema);
  const blocks = [];
  let at = text.indexOf(FRESH_ONLY_GUARD);
  while (at !== -1) {
    const start = text.lastIndexOf('DO $$', at);
    const end = text.indexOf('END $$;', at);
    if (start === -1 || end === -1) throw new Error('a fresh-only guard outside a DO $$ … END $$; block');
    blocks.push(text.slice(start, end + 'END $$;'.length));
    at = text.indexOf(FRESH_ONLY_GUARD, end);
  }
  return blocks;
}

/** The schema as a deployed database applies it: fresh-only blocks removed. */
function deployedBootSchema(schema) {
  let out = String(schema);
  for (const block of freshOnlyBlocks(schema)) out = out.replace(block, '');
  return out;
}

module.exports = { FRESH_ONLY_GUARD, freshOnlyBlocks, deployedBootSchema };
