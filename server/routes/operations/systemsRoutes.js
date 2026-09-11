/**
 * Operations → what is actually running.
 *
 * THE QUESTION NO OTHER SCREEN COULD ANSWER. Every other page in this admin
 * shows what a feature FOUND. None of them shows whether the feature ran. A
 * pass that finds nothing writes nothing, so an empty Needs Attention list and
 * a fuel watch whose timer died since the last deploy look exactly the same
 * from the outside — and this application has already lost weeks of staff
 * alerts to precisely that ambiguity.
 *
 * READ ONLY. There is no endpoint here that restarts a worker, clears a state
 * or retries a pass. A screen that could restart things would be a screen
 * somebody restarts instead of finding out why, and every recovery this system
 * performs is already automatic and already announced. What an operator does
 * with a `needs_human_attention` row is go and configure the thing it names.
 */
const express = require('express');

const observations = require('../../../services/operations/healthObservations');
const runs = require('../../../database/backgroundRuns');
const { CATALOG } = require('../../../lib/operations/backgroundServiceCatalog');
const { sendFailure } = require('../../middleware/failureResponse');

/** Counts per state, so the page can lead with the number that matters. */
function tally(list) {
  const byState = {};
  for (const o of list) byState[o.state] = (byState[o.state] || 0) + 1;
  return byState;
}

function createSystemsRouter({ authMiddleware }) {
  const router = express.Router();

  router.get('/systems', authMiddleware, async (req, res) => {
    try {
      const [observed, ledger] = await Promise.all([
        observations.gatherAllObservations(),
        runs.listRuns(),
      ]);
      const ledgerByKey = new Map(ledger.map((r) => [r.serviceKey, r]));

      const components = observed.map((o) => {
        const row = ledgerByKey.get(o.component) || null;
        return {
          component: o.component,
          label: o.label,
          group: o.group,
          critical: o.critical === true,
          state: o.state,
          reason: o.reason || null,
          lastRunAt: row?.lastFinishedAt || o.lastRunAt || null,
          lastOkAt: row?.lastOkAt || null,
          consecutiveFailures: row?.consecutiveFailures ?? 0,
          runsTotal: row?.runsTotal ?? 0,
          // The pass's own counts, already reduced to numbers and short strings
          // by the ledger — never a payload, a message body or a driver's name.
          lastSummary: row?.lastSummary || null,
          expectedIntervalSeconds: row?.expectedIntervalSeconds
            ?? CATALOG.find((e) => e.key === o.component)?.expectedIntervalSeconds
            ?? null,
        };
      });

      res.json({
        components,
        byState: tally(observed),
        needingAttention: components.filter((c) => (
          c.state === 'needs_human_attention'
          || c.state === 'stale_stopped'
          || c.state === 'repeatedly_failing'
        )).length,
        // How much of the roster has never reported. High here right after a
        // deploy is normal; high a day later means the ledger is not being
        // written, which is its own answer.
        expected: CATALOG.length,
      });
    } catch (err) {
      sendFailure(res, err, {
        message: 'Failed to load the system state', logPrefix: '[SYSTEMS]',
      });
    }
  });

  return router;
}

module.exports = { createSystemsRouter, tally };
