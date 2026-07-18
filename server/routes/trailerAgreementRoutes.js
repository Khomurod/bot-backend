/**
 * Multi-trailer rental agreement API.
 *
 * Thin HTTP layer over services/trailerAgreements — no business logic here. Each
 * write is permission-gated; the service performs validation, transactions,
 * status derivation and audit. Errors thrown by the service carry {status,code}
 * and are surfaced verbatim.
 */
'use strict';

const express = require('express');
const service = require('../../services/trailerAgreements');
const agreementsDb = require('../../database/trailerAgreements');
const itemInspectionsDb = require('../../database/trailerItemInspections');

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function actor(req) {
  return {
    id: req.admin?.id,
    username: req.admin?.username,
    roleKeys: req.admin?.roleKeys || req.admin?.roles,
    ip: req.ip,
  };
}

const { errorPayload } = require('../../services/trailerErrorMessages');

function sendErr(res, err) {
  const { status, payload } = errorPayload(err);
  if (status === 500) console.error('[TRAILER-AGREEMENTS]', err.message);
  res.status(status).json(payload);
}

function createTrailerAgreementRoutes({ authMiddleware, requirePermission }) {
  const router = express.Router();
  const base = '/api/trailer-agreements';
  const view = requirePermission('trailer_agreements.view');
  const manage = requirePermission('trailer_agreements.manage');

  router.use(base, authMiddleware);

  router.get(base, view, asyncRoute(async (req, res) => {
    const { companyId, status, page, pageSize } = req.query;
    res.json(await agreementsDb.listAgreements({ companyId, status, page, pageSize }));
  }));

  // Stateless server-side estimate for the wizard's Price step: computed with
  // the SAME pricing helpers invoicing uses. Writes nothing. MUST be declared
  // before the `${base}/:id` routes so "estimate" is not read as an id.
  router.post(`${base}/estimate`, view, asyncRoute(async (req, res) => {
    res.json({ estimate: service.estimateAgreement(req.body || {}) });
  }));

  router.get(`${base}/:id`, view, asyncRoute(async (req, res) => {
    const agreement = await agreementsDb.getAgreementById(req.params.id);
    if (!agreement) return res.status(404).json({ error: 'Agreement not found.' });
    const [items, amendments, inspections, mediaSummary] = await Promise.all([
      agreementsDb.listItems(req.params.id),
      agreementsDb.listAmendments(req.params.id),
      itemInspectionsDb.listAgreementInspections(req.params.id),
      itemInspectionsDb.summarizeAgreementItemMedia(req.params.id),
    ]);
    return res.json({ agreement, items, amendments, inspections, media_summary: mediaSummary });
  }));

  router.post(base, manage, asyncRoute(async (req, res) => {
    try {
      const result = await service.createAgreementWithItems(req.body || {}, actor(req));
      res.status(201).json(result);
    } catch (err) { sendErr(res, err); }
  }));

  router.post(`${base}/:id/items`, manage, asyncRoute(async (req, res) => {
    try {
      res.status(201).json(await service.addItemViaAmendment(req.params.id, req.body?.item || req.body, actor(req), req.body?.reason));
    } catch (err) { sendErr(res, err); }
  }));

  router.post(`${base}/:id/items/:itemId/remove`, manage, asyncRoute(async (req, res) => {
    try {
      res.json(await service.removeItemViaAmendment(req.params.id, req.params.itemId, actor(req), req.body?.reason));
    } catch (err) { sendErr(res, err); }
  }));

  router.post(`${base}/:id/items/:itemId/replace`, manage, asyncRoute(async (req, res) => {
    try {
      res.json(await service.replaceItemViaAmendment(req.params.id, req.params.itemId, req.body?.item || {}, actor(req), req.body?.reason));
    } catch (err) { sendErr(res, err); }
  }));

  router.post(`${base}/:id/items/:itemId/schedule`, manage, asyncRoute(async (req, res) => {
    try {
      res.json(await service.scheduleItem(req.params.id, req.params.itemId, req.body || {}, actor(req)));
    } catch (err) { sendErr(res, err); }
  }));

  router.post(`${base}/:id/items/:itemId/activate`, manage, asyncRoute(async (req, res) => {
    try {
      res.json(await service.activateItem(req.params.id, req.params.itemId, actor(req),
        {
          version: req.body?.version,
          pickup: {
            actual_pickup_at: req.body?.actual_pickup_at,
            pickup_location: req.body?.pickup_location,
            pickup_lat: req.body?.pickup_lat,
            pickup_lng: req.body?.pickup_lng,
          },
        }));
    } catch (err) { sendErr(res, err); }
  }));

  // Item-scoped inspections: the agreement analogue of the legacy rental
  // inspection pair. Saving is ALWAYS a draft; completion is the only path that
  // verifies fields + photo bytes and flips completed.
  const inspectionsManage = requirePermission('trailer_inspections.manage');
  async function itemInAgreement(req, res) {
    const item = await agreementsDb.getItemById(req.params.itemId);
    if (!item || Number(item.agreement_id) !== Number(req.params.id)) {
      res.status(404).json({ error: 'Item not found.' });
      return null;
    }
    return item;
  }
  router.put(`${base}/:id/items/:itemId/inspections/:type`, inspectionsManage, asyncRoute(async (req, res) => {
    try {
      if (!(await itemInAgreement(req, res))) return;
      const inspection = await itemInspectionsDb.saveItemInspection({
        ...req.body, rental_item_id: req.params.itemId, inspection_type: req.params.type,
      }, actor(req));
      res.json({ inspection });
    } catch (err) { sendErr(res, err); }
  }));
  router.post(`${base}/:id/items/:itemId/inspections/:type/complete`, inspectionsManage, asyncRoute(async (req, res) => {
    try {
      if (!(await itemInAgreement(req, res))) return;
      const inspection = await itemInspectionsDb.completeItemInspection(
        req.params.itemId, req.params.type, actor(req),
      );
      res.json({ inspection });
    } catch (err) { sendErr(res, err); }
  }));

  router.post(`${base}/:id/items/:itemId/return`, manage, asyncRoute(async (req, res) => {
    try {
      res.json(await service.returnItem(req.params.id, req.params.itemId, req.body || {}, actor(req)));
    } catch (err) { sendErr(res, err); }
  }));

  router.post(`${base}/:id/items/:itemId/extend`, manage, asyncRoute(async (req, res) => {
    try {
      res.json(await service.extendReturn(req.params.id, req.params.itemId, req.body?.expected_return_at, actor(req), req.body?.reason, req.body?.version));
    } catch (err) { sendErr(res, err); }
  }));

  router.post(`${base}/:id/items/:itemId/rate`, manage, asyncRoute(async (req, res) => {
    try {
      res.json(await service.changeItemRate(req.params.id, req.params.itemId, req.body?.rate || req.body, actor(req), req.body?.reason, req.body?.version));
    } catch (err) { sendErr(res, err); }
  }));

  router.post(`${base}/:id/amount`, manage, asyncRoute(async (req, res) => {
    try {
      res.json(await service.changeAmount(req.params.id, req.body?.amount, actor(req), req.body?.reason, req.body?.version));
    } catch (err) { sendErr(res, err); }
  }));

  router.post(`${base}/:id/invoices/combined`, manage, asyncRoute(async (req, res) => {
    try {
      res.status(201).json(await service.generateCombinedInvoice(req.params.id, actor(req)));
    } catch (err) { sendErr(res, err); }
  }));

  router.post(`${base}/:id/items/:itemId/invoice`, manage, asyncRoute(async (req, res) => {
    try {
      res.status(201).json(await service.generateItemInvoice(req.params.id, req.params.itemId, actor(req)));
    } catch (err) { sendErr(res, err); }
  }));

  router.post(`${base}/:id/close`, manage, asyncRoute(async (req, res) => {
    try {
      res.json(await service.closeAgreementValidated(req.params.id, actor(req), { version: req.body?.version }));
    } catch (err) { sendErr(res, err); }
  }));

  return router;
}

module.exports = { createTrailerAgreementRoutes };
