#!/usr/bin/env node
/**
 * What the operational corrections WOULD do — and, with --apply, doing it.
 *
 * DRY RUN IS THE DEFAULT. Nothing is written unless you pass --apply, and the
 * counts printed are the ones a human has to agree with before granting
 * anything. Same shape as `scripts/backfill-driver-people.js`.
 *
 *   node scripts/operations-preview.js                # plan only, writes nothing
 *   node scripts/operations-preview.js --sweep        # run the checks first
 *   node scripts/operations-preview.js --apply        # apply what is enabled
 *
 * WHY THIS EXISTS. Until now the only dry run was `GET /api/operations/
 * auto-apply/preview` or a Node require — so the plan behind a repair could not
 * be reproduced, quoted, or reviewed outside a browser session. A repair of ~65
 * production rows deserves a command anyone can re-run and get the same answer
 * from.
 *
 * THE CAP IS THE FIRST THING TO READ. A check whose eligible findings exceed its
 * `max_auto_per_run` applies NOTHING and reports itself under `capped` — so a
 * capped check looks identical to "found nothing" if you only read `eligible`.
 * That is why `capped` is printed loudly, with the fix, rather than tucked into
 * a summary line.
 */
const { runAutoCorrections } = require('../services/operations/corrections/autoApply');
const { runGuardedSweep } = require('../services/operations/consistencyService');
const { listCheckSettings } = require('../database/operationalCheckSettings');

function parseArgs(argv) {
  const args = new Set(argv.slice(2));
  return {
    apply: args.has('--apply'),
    sweep: args.has('--sweep'),
    verbose: args.has('--verbose'),
  };
}

function pad(label, value) {
  console.log(`  ${String(label).padEnd(26)} ${value}`);
}

async function main() {
  const { apply, sweep, verbose } = parseArgs(process.argv);

  if (sweep) {
    console.log('\n=== SWEEP (re-running the checks so the plan is current) ===');
    const result = await runGuardedSweep();
    if (result?.skipped) {
      console.log(`  skipped — ${result.reason}`);
    } else {
      pad('findings filed', result.summary.filed);
      pad('findings resolved', result.summary.resolved);
      for (const failure of result.summary.failures || []) {
        console.log(`  ! check module "${failure.module}" failed: ${failure.error}`);
      }
    }
  }

  const settings = await listCheckSettings();
  console.log('\n=== PERMISSIONS (a check with no row is disabled) ===');
  if (!settings.length) {
    console.log('  none — nothing may be applied automatically');
  }
  for (const s of settings) {
    pad(s.checkKey, `${s.autoApplyEnabled ? 'ENABLED' : 'disabled'}  cap ${s.maxAutoPerRun}`);
  }

  const { summary, plan, capped, results } = await runAutoCorrections({ apply });

  console.log(apply ? '\n=== APPLIED ===' : '\n=== PLAN (dry run — nothing written) ===');
  pad('open findings', summary.open);
  pad('eligible to apply', summary.eligible);
  pad('skipped: not enabled', summary.skipped.disabled);
  pad('skipped: no payload', summary.skipped.noPayload);
  if (summary.skipped.noAction) pad('settings for unknown check', summary.skipped.noAction);
  if (apply) {
    pad('applied', summary.applied);
    pad('skipped as stale', summary.stale);
    pad('failed', summary.failed);
  }

  // Loud, because a capped check reports eligible: 0 and looks exactly like a
  // check that found nothing at all.
  if (capped.length) {
    console.log('\n!!! CAPPED — these checks applied NOTHING !!!');
    for (const c of capped) {
      console.log(`  ${c.checkKey}: wants ${c.wanted}, cap ${c.cap}`);
      console.log(`    → raise it: PUT /api/operations/checks/${c.checkKey} `
        + `{ "autoApplyEnabled": true, "maxAutoPerRun": ${Math.min(500, c.wanted)} }`);
    }
  }

  if (!apply && plan?.length) {
    console.log(`\n=== WHAT WOULD CHANGE (${plan.length}) ===`);
    const show = verbose ? plan : plan.slice(0, 20);
    for (const item of show) {
      console.log(`  • [${item.checkKey}] ${item.describe}`);
    }
    if (show.length < plan.length) {
      console.log(`  … and ${plan.length - show.length} more (--verbose for all)`);
    }
  }

  if (apply && results?.length) {
    const stale = results.filter((r) => r.stale);
    const failed = results.filter((r) => !r.ok && !r.stale);
    for (const r of stale) console.log(`  ~ finding ${r.findingId} skipped: ${r.error}`);
    for (const r of failed) console.log(`  ! finding ${r.findingId} FAILED: ${r.error}`);
  }

  console.log('');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\nFailed:', err.message);
    process.exit(1);
  });
