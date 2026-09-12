/**
 * Operations → things a person has to build.
 *
 * WHAT THIS ROUTER IS ALLOWED TO DO, stated as the short list it is: read the
 * requests, and record a person's decision about one. That is all. There is no
 * endpoint that runs anything, fetches anything a request mentions, or writes a
 * file — the runtime bot never touches source code, and a router with no path
 * to it cannot be argued into one.
 *
 * `linked_reference` is free text somebody types, such as "PR #231". It is
 * stored and displayed. It is never parsed, never resolved, never fetched.
 *
 * THE APPLY GATE GUARDS DECIDING, not reading — the same split the corrections
 * and learning routers make. Seeing what has been asked for is part of looking
 * at the system; declaring it done is a change somebody owns.
 */
const express = require('express');

const store = require('../../../database/engineeringRequests');
const { insertAdminAudit } = require('../../../database/adminAudit');
const { sendFailure } = require('../../middleware/failureResponse');

const STATUSES = ['open', 'accepted', 'in_progress', 'done', 'declined'];

function createEngineeringRouter({ authMiddleware, applyMiddleware = authMiddleware }) {
  const router = express.Router();

  router.get('/engineering-requests', authMiddleware, async (req, res) => {
    try {
      const status = STATUSES.includes(String(req.query.status)) ? String(req.query.status) : null;
      const [requests, summary] = await Promise.all([
        store.listRequests({ status, limit: 100 }),
        store.summariseRequests(),
      ]);
      res.json({ requests, summary });
    } catch (err) {
      sendFailure(res, err, {
        message: 'Failed to load engineering requests', logPrefix: '[OPERATIONS]',
      });
    }
  });

  router.post('/engineering-requests/:id/decide', applyMiddleware, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) {
        res.status(400).json({ error: 'Invalid request id' });
        return;
      }
      const status = String(req.body?.status || '');
      if (!STATUSES.includes(status)) {
        res.status(400).json({ error: `Status must be one of: ${STATUSES.join(', ')}` });
        return;
      }
      const before = await store.getRequestById(id);
      if (!before) {
        res.status(404).json({ error: 'That request does not exist.' });
        return;
      }
      const request = await store.decideRequest(id, {
        status,
        summary: req.body?.summary ?? null,
        linkedReference: req.body?.linkedReference ?? null,
        decisionNote: req.body?.decisionNote ?? null,
        decidedBy: req.admin?.username || `admin:${req.admin?.id ?? ''}`,
      });
      await insertAdminAudit({
        adminId: req.admin?.id ?? null,
        roleKeys: req.admin?.roleKeys || [],
        action: 'engineering_request.decide',
        entityType: 'engineering_request',
        entityId: String(id),
        oldValues: { status: before.status },
        newValues: { status: request.status },
        reason: req.body?.decisionNote || null,
        ipAddress: req.ip || null,
      }).catch(() => {});
      res.json({ request });
    } catch (err) {
      sendFailure(res, err, {
        message: 'Failed to record that decision', logPrefix: '[OPERATIONS]',
      });
    }
  });

  return router;
}

module.exports = { createEngineeringRouter, STATUSES };
