#!/usr/bin/env node
/**
 * Populate the person identity layer from the groups and profiles that exist.
 *
 * DRY RUN IS THE DEFAULT. Nothing is written unless you pass --apply. Read the
 * plan first: the counts it prints are the ones a human has to agree with, and
 * the two lists at the bottom are the things this backfill deliberately REFUSES
 * to decide.
 *
 * Usage:
 *   node scripts/backfill-driver-people.js            # plan only, writes nothing
 *   node scripts/backfill-driver-people.js --apply    # write it
 *
 * Re-running is safe: a group that already belongs to somebody is skipped, so a
 * second run is a no-op and a run after new groups appear picks up only those.
 */
const { runPersonBackfill } = require('../services/identity/personBackfillService');

function parseArgs(argv) {
  const args = new Set(argv.slice(2));
  return { apply: args.has('--apply'), verbose: args.has('--verbose') };
}

function printCandidates(title, entries, describe) {
  if (!entries.length) return;
  console.log(`\n${title} (${entries.length}) — reported, NOT decided:`);
  for (const entry of entries) console.log(`  • ${describe(entry)}`);
}

async function main() {
  const { apply, verbose } = parseArgs(process.argv);
  const { plan, applied, dryRun } = await runPersonBackfill({ apply });

  console.log(dryRun ? '\n=== PLAN (dry run — nothing written) ===' : '\n=== APPLIED ===');
  for (const [key, value] of Object.entries(plan.stats)) {
    console.log(`  ${key.padEnd(24)} ${value}`);
  }

  printCandidates(
    'Same name, no hard anchor', plan.mergeCandidates,
    (c) => `${c.normalizedKey}: groups ${c.people.map((p) => p.groupIds.join('+')).join(' vs ')}`
  );
  printCandidates(
    'One unit, several drivers', plan.contestedUnits,
    (c) => `unit ${c.unitNumber}: ${c.people.map((p) => `${p.displayName} (${p.groupIds.join(',')})`).join(' vs ')}`
  );

  if (verbose) {
    console.log('\nPeople:');
    for (const person of plan.people) {
      console.log(`  ${person.displayName} — groups ${person.groups.map((g) => g.groupId).join(',')} unit ${person.unitNumber || '—'}`);
    }
  }

  if (applied) {
    console.log('\nWrites:');
    for (const [key, value] of Object.entries(applied)) console.log(`  ${key.padEnd(24)} ${value}`);
  } else {
    console.log('\nNothing was written. Re-run with --apply once the plan above looks right.');
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[BACKFILL] failed:', err.message);
    process.exit(1);
  });
