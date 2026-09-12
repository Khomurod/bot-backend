/**
 * Reading the Needs Attention page, and the two decisions a person makes on it
 * that change nothing about the fleet.
 *
 * Everything here is gated on `admin.full_access` — the same gate as the rest of
 * the admin — because none of it can alter a driver record. Dismissing a finding
 * and snoozing one are decisions about the SYSTEM'S OWN NOTES, and running a
 * sweep on demand does exactly what the 15-minute timer already does. The routes
 * that change fleet data live in `correctionsRoutes.js` behind a separate
 * permission.
 *
 * A DISMISSAL REQUIRES A REASON, and that rule is a database CHECK
 * (`operational_findings_dismissal_has_reason`), not a nicety of this layer. The
 * route validates it anyway so the admin gets a sentence it can show, instead of
 * a constraint violation nobody outside Postgres can read.
 */
const express = require('express');

const findingsStore = require('../../../database/operationalFindings');
const correctionsStore = require('../../../database/operationalCorrections');
const controlReplyStore = require('../../../database/controlReplies');
const knowledgeStore = require('../../../database/controlKnowledge');
const { runGuardedSweep, getConsistencyStatus } = require('../../../services/operations/consistencyService');
const { CHECK_TO_ACTION } = require('../../../services/operations/corrections/actions');
const { sendFailure } = require('../../middleware/failureResponse');
const { memoryApplies } = require('../../../lib/control/fingerprint');

const MAX_SNOOZE_HOURS = 24 * 30;

function positiveIntParam(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** A finding the registry can actually act on, so the UI knows to offer a button. */
function withActionability(finding) {
  if (!finding) return finding;
  return { ...finding, actionable: CHECK_TO_ACTION.has(finding.checkKey) };
}

function createFindingsRouter({ authMiddleware }) {
  const router = express.Router();

  /**
   * The tiles, plus enough context to explain a quiet page.
   *
   * `sweep` is included because "no findings" and "the sweep has not run since
   * the last deploy" look identical on screen and mean opposite things.
   */
  router.get('/summary', authMiddleware, async (req, res) => {
    try {
      const [findings, corrections] = await Promise.all([
        findingsStore.summariseFindings(),
        correctionsStore.summariseCorrections(),
      ]);
      res.json({ findings, corrections, sweep: getConsistencyStatus() });
    } catch (err) {
      sendFailure(res, err, { message: 'Failed to load the operations summary', logPrefix: '[OPERATIONS]' });
    }
  });

  router.get('/findings', authMiddleware, async (req, res) => {
    try {
      // 'all' means no filter at all. A bare absent/empty status has to keep
      // meaning 'open' — that is what every other caller expects — so the
      // "show me the dismissed ones too" case needs a word of its own.
      const status = req.query.status || 'open';
      const rows = await findingsStore.listFindings({
        status: status === 'all' ? null : status,
        severity: req.query.severity || null,
        checkKey: req.query.checkKey || null,
        tier: req.query.tier || null,
        includeSnoozed: req.query.includeSnoozed === 'true',
        limit: Math.min(500, Number(req.query.limit) || 200),
      });
      res.json({ findings: rows.map(withActionability) });
    } catch (err) {
      sendFailure(res, err, { message: 'Failed to load findings', logPrefix: '[OPERATIONS]' });
    }
  });

  /**
   * One finding with everything the drawer shows: its evidence, its proposed
   * change, and whatever has already been done about it.
   */
  router.get('/findings/:id', authMiddleware, async (req, res) => {
    const id = positiveIntParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid finding id' });
    try {
      const finding = await findingsStore.getFindingById(id);
      if (!finding) return res.status(404).json({ error: 'Finding not found' });
      const corrections = await correctionsStore.listCorrections({ findingId: id, limit: 20 });
      // WHAT WAS SAID ABOUT THIS IN TELEGRAM, and what Wenze took from it.
      // Without these two, a finding answered from a phone reads on this screen
      // as one that closed itself — and "Already answered in the notification
      // group" in a dismissal reason points at a conversation nobody can see.
      // Both fail soft: this screen is how somebody investigates, and it must
      // still open when a side query cannot run.
      const [controlReplies, stored] = await Promise.all([
        controlReplyStore.listRepliesForFinding(id).catch(() => []),
        knowledgeStore.findMemory({
          checkKey: finding.checkKey,
          subjectType: finding.subjectType,
          subjectId: String(finding.subjectId),
        }).catch(() => null),
      ]);
      // THE SAME TEST THE SWEEP APPLIES, and it has to be the same one. A row
      // keyed on this subject is not necessarily an answer to THIS condition:
      // once the situation changes the ask pass correctly ignores it and asks
      // again, and a screen that still showed it would tell an administrator
      // Wenze is remembering something it is not — and offer them a Forget
      // button for an answer about a different situation.
      const memory = memoryApplies(finding, stored) ? stored : null;
      return res.json({ finding: withActionability(finding), corrections, controlReplies, memory });
    } catch (err) {
      return sendFailure(res, err, { message: 'Failed to load the finding', logPrefix: '[OPERATIONS]' });
    }
  });

  router.post('/findings/:id/dismiss', authMiddleware, async (req, res) => {
    const id = positiveIntParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid finding id' });
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason) {
      return res.status(400).json({
        error: 'A dismissal needs a reason — it is what tells the next person why this was left alone.',
      });
    }
    try {
      const finding = await findingsStore.dismissFinding(id, {
        dismissedBy: req.admin?.username || null, reason,
      });
      if (!finding) {
        return res.status(409).json({ error: 'That finding is no longer open.' });
      }
      return res.json({ finding: withActionability(finding) });
    } catch (err) {
      return sendFailure(res, err, { message: 'Failed to dismiss the finding', logPrefix: '[OPERATIONS]' });
    }
  });

  /**
   * Put a finding aside without pretending it went away.
   *
   * A snooze is bounded — 30 days, not forever — because an alert that can be
   * silenced permanently without a reason is how a page stops being read.
   */
  router.post('/findings/:id/snooze', authMiddleware, async (req, res) => {
    const id = positiveIntParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid finding id' });
    const hours = Number(req.body?.hours);
    if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_SNOOZE_HOURS) {
      return res.status(400).json({ error: `Snooze must be between 1 and ${MAX_SNOOZE_HOURS} hours.` });
    }
    try {
      const until = new Date(Date.now() + hours * 3600000).toISOString();
      const finding = await findingsStore.snoozeFinding(id, until);
      if (!finding) return res.status(404).json({ error: 'Finding not found' });
      return res.json({ finding: withActionability(finding) });
    } catch (err) {
      return sendFailure(res, err, { message: 'Failed to snooze the finding', logPrefix: '[OPERATIONS]' });
    }
  });

  /**
   * Run the checks now.
   *
   * Writes findings, never fleet records — the same thing the timer does every
   * 15 minutes — so it sits on the read gate. It exists because an operator who
   * has just fixed something by hand should not have to wait a quarter of an
   * hour to see the finding clear.
   *
   * Through `runGuardedSweep`, NOT `runConsistencySweep`, and the difference is
   * correctness rather than politeness: two overlapping sweeps carry different
   * `keepIds` sets, so the one that starts first and commits last resolves
   * findings the newer sweep just re-filed. A click landing mid-timer would have
   * done exactly that. 409 rather than an error — nothing went wrong, the work
   * is already happening.
   *
   * `correct: false`, explicitly. The timer's sweep applies the permitted
   * corrections after filing; this one must not, because it sits on the READ
   * gate — an administrator who deliberately lacks
   * `operations.corrections.apply` would otherwise be able to trigger
   * corrections by pressing "Run checks now", audited as `system`.
   */
  router.post('/sweep', authMiddleware, async (req, res) => {
    try {
      const result = await runGuardedSweep({ correct: false });
      if (result?.skipped) {
        return res.status(409).json({ error: result.reason, running: true });
      }
      return res.json({ sweep: result, status: getConsistencyStatus() });
    } catch (err) {
      return sendFailure(res, err, { message: 'The consistency sweep failed', logPrefix: '[OPERATIONS]' });
    }
  });

  return router;
}

module.exports = { createFindingsRouter, MAX_SNOOZE_HOURS, withActionability };
