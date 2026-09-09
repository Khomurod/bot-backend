/**
 * The routes that actually change fleet records — and the one permission that
 * separates them from merely looking.
 *
 * Every route here is gated on `operations.corrections.apply` INSTEAD of
 * `admin.full_access`, not in addition to it. An OR against the blanket gate
 * would hand this to everyone who can open the page and separate nothing, which
 * is the whole reason migration 0018 exists.
 *
 * Three failures are answered distinctly, because they mean different things to
 * the person clicking:
 *
 *   404 — the finding or correction is gone.
 *   409 — the evidence moved. A `StaleCorrectionError` is NOT a server fault: it
 *         is the action refusing to overwrite somebody who got there first, or
 *         whose edit invalidated the proposal. The admin should re-read the row,
 *         so it is a conflict, not an error.
 *   400 — this finding is reported only. Most checks have no registered action
 *         at all (the default), and asking to apply one is a request that can
 *         never be satisfied rather than something that went wrong.
 */
const express = require('express');

const findingsStore = require('../../../database/operationalFindings');
const correctionsStore = require('../../../database/operationalCorrections');
const checkSettingsStore = require('../../../database/operationalCheckSettings');
const { actionForCheck, CHECK_TO_ACTION, getAction } = require('../../../services/operations/corrections/actions');
const { applyCorrection, revertCorrection } = require('../../../services/operations/corrections/apply');
const { runAutoCorrections, payloadFor, DEFAULT_CAP } = require('../../../services/operations/corrections/autoApply');
const { sendFailure } = require('../../middleware/failureResponse');

function positiveIntParam(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Who did this, in the shape the audit mirror wants. Never a model. */
function actorFrom(req) {
  return {
    id: req.admin?.id ?? null,
    username: req.admin?.username ?? null,
    roleKeys: req.admin?.role_keys || [],
    ip: req.ip || null,
  };
}

function isStale(err) {
  return err?.stale === true || err?.name === 'StaleCorrectionError';
}

function createCorrectionsRouter({ authMiddleware, applyMiddleware }) {
  const router = express.Router();

  router.get('/corrections', authMiddleware, async (req, res) => {
    try {
      const live = req.query.live === 'true' ? true : (req.query.live === 'false' ? false : null);
      const corrections = await correctionsStore.listCorrections({
        actionKey: req.query.actionKey || null,
        subjectType: req.query.subjectType || null,
        subjectId: req.query.subjectId || null,
        live,
        limit: Math.min(200, Number(req.query.limit) || 100),
        offset: Math.max(0, Number(req.query.offset) || 0),
      });
      res.json({ corrections });
    } catch (err) {
      sendFailure(res, err, { message: 'Failed to load the correction history', logPrefix: '[OPERATIONS]' });
    }
  });

  /**
   * One correction, plus every correction event recorded against the same
   * subject.
   *
   * `subjectAudit`, deliberately not `audit`: `admin_audit_log` is keyed by
   * `(entity_type, entity_id)` and holds no correction id, so for a driver
   * corrected more than once these rows cover ALL of them. Presenting that as
   * this correction's own trail would be a lie the reader cannot detect.
   */
  router.get('/corrections/:id', authMiddleware, async (req, res) => {
    const id = positiveIntParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid correction id' });
    try {
      const correction = await correctionsStore.getCorrectionById(id);
      if (!correction) return res.status(404).json({ error: 'Correction not found' });
      const subjectAudit = await correctionsStore.listAuditForSubject({
        entityType: correction.subjectType, entityId: correction.subjectId,
      });
      return res.json({ correction, subjectAudit });
    } catch (err) {
      return sendFailure(res, err, { message: 'Failed to load the correction', logPrefix: '[OPERATIONS]' });
    }
  });

  /**
   * Apply the change one finding proposes.
   *
   * The payload comes from the finding's own `proposedChange` and nothing here
   * recomputes it — the action re-derives its answer from the live rows inside
   * its own transaction, which is where a proposal that has gone stale is
   * caught. This route's job is to identify the action and name the actor.
   */
  router.post('/findings/:id/apply', applyMiddleware, async (req, res) => {
    const id = positiveIntParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid finding id' });
    try {
      const finding = await findingsStore.getFindingById(id);
      if (!finding) return res.status(404).json({ error: 'Finding not found' });
      if (finding.status !== 'open') {
        return res.status(409).json({ error: `That finding is already ${finding.status}.` });
      }
      const action = actionForCheck(finding.checkKey);
      if (!action) {
        return res.status(400).json({
          error: 'This finding is reported only — nothing is registered that may change it automatically.',
        });
      }
      const payload = payloadFor(finding);
      if (!payload) {
        return res.status(400).json({ error: 'This finding carries no proposed change to apply.' });
      }
      const correction = await applyCorrection({
        actionKey: action.key,
        payload,
        finding,
        admin: actorFrom(req),
        reason: typeof req.body?.reason === 'string' ? req.body.reason.trim() || null : null,
      });
      return res.json({ correction: correctionsStore.mapCorrection(correction) });
    } catch (err) {
      if (isStale(err)) return res.status(409).json({ error: err.message, stale: true });
      return sendFailure(res, err, { message: 'Failed to apply the correction', logPrefix: '[OPERATIONS]' });
    }
  });

  /**
   * Undo one.
   *
   * A refused revert (409) is the system protecting an edit somebody made after
   * the correction landed. Nothing is written, and the correction stays live.
   */
  router.post('/corrections/:id/revert', applyMiddleware, async (req, res) => {
    const id = positiveIntParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid correction id' });
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    try {
      const correction = await revertCorrection({
        correctionId: id, admin: actorFrom(req), reason: reason || null,
      });
      return res.json({ correction: correctionsStore.mapCorrection(correction) });
    } catch (err) {
      if (isStale(err)) return res.status(409).json({ error: err.message, stale: true });
      if (/already reverted|not found|changed under us/i.test(err.message || '')) {
        return res.status(409).json({ error: err.message });
      }
      return sendFailure(res, err, { message: 'Failed to revert the correction', logPrefix: '[OPERATIONS]' });
    }
  });

  /**
   * What auto-apply WOULD do, writing nothing.
   *
   * On the read gate deliberately: a dry run is how an operator decides whether
   * to grant a check permission in the first place, and requiring the permission
   * to see what granting it would do is backwards.
   */
  router.get('/auto-apply/preview', authMiddleware, async (req, res) => {
    try {
      const result = await runAutoCorrections({ apply: false });
      res.json(result);
    } catch (err) {
      sendFailure(res, err, { message: 'Failed to preview auto-apply', logPrefix: '[OPERATIONS]' });
    }
  });

  /**
   * Every check the registry can act on, with its permission — including the
   * ones nobody has enabled, which is most of them and the entire point.
   */
  router.get('/checks', authMiddleware, async (req, res) => {
    try {
      const stored = new Map((await checkSettingsStore.listCheckSettings()).map((s) => [s.checkKey, s]));
      const checks = [...CHECK_TO_ACTION.keys()].map((checkKey) => {
        const action = getAction(CHECK_TO_ACTION.get(checkKey));
        const setting = stored.get(checkKey);
        return {
          checkKey,
          actionKey: action?.key || null,
          tier: action?.tier || null,
          subjectType: action?.subjectType || null,
          autoApplyEnabled: setting ? setting.autoApplyEnabled : false,
          maxAutoPerRun: setting ? setting.maxAutoPerRun : DEFAULT_CAP,
          updatedBy: setting?.updatedBy || null,
          updatedAt: setting?.updatedAt || null,
          configured: Boolean(setting),
        };
      });
      res.json({ checks });
    } catch (err) {
      sendFailure(res, err, { message: 'Failed to load check settings', logPrefix: '[OPERATIONS]' });
    }
  });

  /** Grant or revoke auto-apply for one check. Unknown check keys are refused. */
  router.put('/checks/:checkKey', applyMiddleware, async (req, res) => {
    const { checkKey } = req.params;
    if (!CHECK_TO_ACTION.has(checkKey)) {
      return res.status(400).json({ error: `No registered action answers "${checkKey}".` });
    }
    try {
      const setting = await checkSettingsStore.upsertCheckSettings(checkKey, {
        autoApplyEnabled: req.body?.autoApplyEnabled === true,
        maxAutoPerRun: req.body?.maxAutoPerRun ?? null,
        updatedBy: req.admin?.username || null,
      });
      return res.json({ setting });
    } catch (err) {
      return sendFailure(res, err, { message: 'Failed to save check settings', logPrefix: '[OPERATIONS]' });
    }
  });

  return router;
}

module.exports = { createCorrectionsRouter, actorFrom, isStale };
