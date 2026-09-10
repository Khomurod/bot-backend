#!/usr/bin/env node
/**
 * What the operational corrections WOULD do — and, with --apply, doing it.
 *
 * DRY RUN IS THE DEFAULT. `--apply` is the ONLY thing that writes, and that is
 * true of `--sweep` too: a sweep files findings and resolves cleared ones, so
 * without `--apply` it computes and reports and writes nothing. The counts
 * printed are the ones a human has to agree with before granting anything. Same
 * shape as `scripts/backfill-driver-people.js`.
 *
 *   node scripts/operations-preview.js                # plan only, writes nothing
 *   node scripts/operations-preview.js --sweep        # what the checks see now
 *   node scripts/operations-preview.js --sweep --apply  # file findings, then apply
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
 *
 * AND IT EXITS NON-ZERO WHEN AN APPLY DID NOT DO ITS JOB. A runbook that reads
 * exit 0 as "the repair ran" must not be told that by a run where every
 * correction was blocked by the cap.
 */
const { runAutoCorrections: defaultRunAutoCorrections } = require('../services/operations/corrections/autoApply');
const { runGuardedSweep: defaultRunGuardedSweep } = require('../services/operations/consistencyService');
const { listCheckSettings: defaultListCheckSettings } = require('../database/operationalCheckSettings');

/**
 * `operational_check_settings.max_auto_per_run` is
 * `CHECK (max_auto_per_run BETWEEN 1 AND 500)` (migration 0017). It is a hard
 * ceiling, not a default, which is why a batch larger than this cannot be
 * unblocked by raising the cap at all.
 */
const MAX_AUTO_PER_RUN = 500;

function parseArgs(argv) {
  const args = new Set(argv.slice(2));
  return {
    apply: args.has('--apply'),
    sweep: args.has('--sweep'),
    verbose: args.has('--verbose'),
  };
}

/**
 * What to tell an operator about a capped check. PURE.
 *
 * `planForCheck` refuses whenever `wanted > cap`, so the cap that unblocks a
 * batch is exactly `wanted` — and when `wanted` exceeds the column's hard
 * maximum there is no such cap. Printing "set it to 500" for 501 eligible
 * findings is worse than printing nothing: the operator does what the tool said,
 * the batch is still capped, and the tool looks like it lied.
 */
function capAdvice(capped = []) {
  return capped.map((c) => {
    const raisable = c.wanted <= MAX_AUTO_PER_RUN;
    return {
      checkKey: c.checkKey,
      wanted: c.wanted,
      cap: c.cap,
      raisable,
      headline: `${c.checkKey}: wants ${c.wanted}, cap ${c.cap}`,
      fix: raisable
        ? `raise it: PUT /api/operations/checks/${c.checkKey} `
          + `{ "autoApplyEnabled": true, "maxAutoPerRun": ${c.wanted} }`
        : `auto-apply cannot process this batch: ${c.wanted} findings exceed the hard `
          + `maximum of ${MAX_AUTO_PER_RUN} on max_auto_per_run, so no cap unblocks it. `
          + `Narrow the batch (dismiss or snooze what does not belong) or work it in `
          + `reviewed batches from Admin → Operations → Needs Attention.`,
    };
  });
}

/**
 * The process exit status. PURE.
 *
 * A DRY RUN ALWAYS SUCCEEDS — reporting is its whole job, and a capped check is
 * exactly the thing it exists to report. An `--apply` run is different: it was
 * asked to change the fleet, so anything that stopped it from doing so is a
 * failure the shell has to see.
 */
function exitCodeFor({ apply, summary = {}, capped = [], sweep = null }) {
  if (!apply) return 0;
  if (capped.length) return 1;
  if ((summary.failed || 0) > 0) return 1;
  if (sweep && (sweep.failures || []).length) return 1;
  return 0;
}

async function main(argv = process.argv, deps = {}) {
  const {
    runAutoCorrections = defaultRunAutoCorrections,
    runGuardedSweep = defaultRunGuardedSweep,
    listCheckSettings = defaultListCheckSettings,
    log = console,
  } = deps;

  const { apply, sweep, verbose } = parseArgs(argv);
  const pad = (label, value) => log.log(`  ${String(label).padEnd(26)} ${value}`);

  let sweepSummary = null;
  if (sweep) {
    log.log(apply
      ? '\n=== SWEEP (re-running the checks and filing what they find) ==='
      : '\n=== SWEEP (dry — what the checks see right now; nothing filed) ===');
    // `apply` and not `true`: the sweep upserts findings and resolves cleared
    // ones, which is a write to the table the Needs Attention page reads. It
    // does not get to happen under a flag documented as a preview.
    //
    // `correct: false` because THIS script applies the batch itself, right
    // below, with its own reporting. A sweep that also corrected would apply
    // twice: the second pass would report zero applied after real writes had
    // happened, and first-pass failures would be discarded or retried.
    const result = await runGuardedSweep({ apply, correct: false });
    if (result?.skipped) {
      log.log(`  skipped — ${result.reason}`);
    } else {
      sweepSummary = result.summary;
      pad('conditions found', result.summary.found);
      pad('findings filed', result.summary.filed);
      pad('findings resolved', result.summary.resolved);
      for (const failure of result.summary.failures || []) {
        log.log(`  ! check module "${failure.module}" failed: ${failure.error}`);
      }
      if (!apply) {
        log.log('  note: nothing was filed, so the plan below is computed from the');
        log.log('        findings ALREADY STORED. Re-run with --apply to file these first.');
      }
    }
  }

  const settings = await listCheckSettings();
  log.log('\n=== PERMISSIONS (a check with no row is disabled) ===');
  if (!settings.length) {
    log.log('  none — nothing may be applied automatically');
  }
  for (const s of settings) {
    pad(s.checkKey, `${s.autoApplyEnabled ? 'ENABLED' : 'disabled'}  cap ${s.maxAutoPerRun}`);
  }

  const { summary, plan, capped, results } = await runAutoCorrections({ apply });

  log.log(apply ? '\n=== APPLIED ===' : '\n=== PLAN (dry run — nothing written) ===');
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
  const advice = capAdvice(capped);
  if (advice.length) {
    log.log('\n!!! CAPPED — these checks applied NOTHING !!!');
    for (const a of advice) {
      log.log(`  ${a.headline}`);
      log.log(`    → ${a.fix}`);
    }
  }

  if (!apply && plan?.length) {
    log.log(`\n=== WHAT WOULD CHANGE (${plan.length}) ===`);
    const show = verbose ? plan : plan.slice(0, 20);
    for (const item of show) {
      log.log(`  • [${item.checkKey}] ${item.describe}`);
    }
    if (show.length < plan.length) {
      log.log(`  … and ${plan.length - show.length} more (--verbose for all)`);
    }
  }

  if (apply && results?.length) {
    const stale = results.filter((r) => r.stale);
    const failed = results.filter((r) => !r.ok && !r.stale);
    for (const r of stale) log.log(`  ~ finding ${r.findingId} skipped: ${r.error}`);
    for (const r of failed) log.log(`  ! finding ${r.findingId} FAILED: ${r.error}`);
  }

  const code = exitCodeFor({ apply, summary, capped, sweep: sweepSummary });
  if (code !== 0) {
    log.log('\nThis apply did NOT complete its work — exiting non-zero so a runbook');
    log.log('does not record it as a repair that ran.');
  }
  log.log('');
  return code;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('\nFailed:', err.message);
      process.exit(1);
    });
}

module.exports = { main, capAdvice, exitCodeFor, MAX_AUTO_PER_RUN };
