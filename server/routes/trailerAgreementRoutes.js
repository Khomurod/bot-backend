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

function sendErr(res, err) {
  const status = err.status || 500;
  res.status(status).json({ error: err.message, code: err.code || undefined });
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

  router.get(`${base}/:id`, view, asyncRoute(async (req, res) => {
    const agreement = await agreementsDb.getAgreementById(req.params.id);
    if (!agreement) return res.status(404).json({ error: 'Agreement not found.' });
    const [items, amendments] = await Promise.all([
      agreementsDb.listItems(req.params.id),
      agreementsDb.listAmendments(req.params.id),
    ]);
    return res.json({ agreement, items, amendments });
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
      res.json(await service.activateItem(req.params.id, req.params.itemId, actor(req)));
    } catch (err) { sendErr(res, err); }
  }));

  router.post(`${base}/:id/items/:itemId/return`, manage, asyncRoute(async (req, res) => {
    try {
      res.json(await service.returnItem(req.params.id, req.params.itemId, req.body || {}, actor(req)));
    } catch (err) { sendErr(res, err); }
  }));

  router.post(`${base}/:id/items/:itemId/extend`, manage, asyncRoute(async (req, res) => {
    try {
      res.json(await service.extendReturn(req.params.id, req.params.itemId, req.body?.expected_return_at, actor(req), req.body?.reason));
    } catch (err) { sendErr(res, err); }
  }));

  router.post(`${base}/:id/items/:itemId/rate`, manage, asyncRoute(async (req, res) => {
    try {
      res.json(await service.changeItemRate(req.params.id, req.params.itemId, req.body?.rate || req.body, actor(req), req.body?.reason));
    } catch (err) { sendErr(res, err); }
  }));

  router.post(`${base}/:id/amount`, manage, asyncRoute(async (req, res) => {
    try {
      res.json(await service.changeAmount(req.params.id, req.body?.amount, actor(req), req.body?.reason));
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
    res.json({ agreement: await agreementsDb.closeAgreement(req.params.id, req.admin?.id) });
  }));

  return router;
}

module.exports = { createTrailerAgreementRoutes };
