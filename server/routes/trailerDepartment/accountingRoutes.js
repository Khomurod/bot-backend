/**
 * Trailer Department — money: invoices, adjustments, payments, reversals,
 * company credits, and the overdue-reminder ledger.
 *
 * MONEY INVARIANTS this module is the gate for (see
 * docs/architecture/trailer-invariants.md):
 *   - invoice history is IMMUTABLE — a correction is an adjustment row, and a
 *     wrong payment is a reversal row; nothing here edits or deletes history;
 *   - recording a payment with NO receipt needs
 *     `trailer_payments.record_without_receipt`;
 *   - an overpayment needs both `trailer_payments.record_overpayment` AND an
 *     explicit confirm flag in the request, so it can never be a slip;
 *   - recordTrailerPayment dedupes, and a duplicate must not leave uploaded
 *     receipt bytes behind — hence the removeObjects calls.
 *
 * Split out of server/routes/trailerDepartmentRoutes.js.
 */
'use strict';

const express = require('express');
const storage = require('../../../services/trailerStorageService');
const { pokeTrailerNotificationQueue } = require('../../../services/trailerNotificationService');
const { upload, asyncRoute, actor, can, storeFile, cleanupFiles } = require('./shared');

function createTrailerDepartmentAccountingRoutes({ db, requirePermission }) {
  const router = express.Router();

  router.get(
    '/api/trailer-department/invoices',
    requirePermission('trailer_payments.view'),
    asyncRoute(async (req, res) => {
      const data = await db.listTrailerInvoices({
        ...req.query,
        companyId: req.query.companyId ?? req.query.company_id,
        agreementId: req.query.agreementId ?? req.query.agreement_id,
      });
      // Paged → the standard envelope (+ invoices alias for old readers); else legacy bare array.
      res.json(Array.isArray(data) ? { invoices: data } : { ...data, invoices: data.items });
    }),
  );

  router.get(
    '/api/trailer-department/invoices/:id',
    requirePermission('trailer_payments.view'),
    asyncRoute(async (req, res) => {
      const invoice = await db.getTrailerInvoice(req.params.id);
      if (!invoice) return res.status(404).json({ error: 'Invoice not found.' });
      res.json({ invoice });
    }),
  );

  // A correction to an issued invoice is an ADJUSTMENT row, never an edit.
  router.post(
    '/api/trailer-department/invoices/:id/adjustments',
    requirePermission('trailer_payments.record'),
    asyncRoute(async (req, res) => res.status(201).json(
      await db.addTrailerInvoiceAdjustment(req.params.id, req.body || {}, actor(req)),
    )),
  );

  router.post(
    '/api/trailer-department/payments',
    requirePermission('trailer_payments.record'),
    (req, res, next) => {
      upload.single('receipt')(req, res, async (uploadError) => {
        if (uploadError) return next(Object.assign(uploadError, { status: 400 }));
        let descriptor;
        try {
          if (!req.file && !can(req, 'trailer_payments.record_without_receipt')) {
            return res.status(403).json({ error: 'Receipt bypass permission required.' });
          }
          if (req.file) {
            descriptor = await storeFile(
              req.file, 'payment_receipt', req.body.invoice_id || 'unassigned',
            );
          }
          // Overpayment is only allowed with the permission AND explicit confirmation.
          const allowOverpayment = can(req, 'trailer_payments.record_overpayment')
            && (req.body.confirm_overpayment === 'true' || req.body.confirm_overpayment === true);
          const result = await db.recordTrailerPayment(
            { ...req.body, allow_overpayment: allowOverpayment }, actor(req), descriptor,
          );
          if (result.duplicate && descriptor?.uploadedPaths) {
            await storage.removeObjects(descriptor.uploadedPaths);
          }
          // recordTrailerPayment queued a payment_confirmation job; deliver it on
          // this request rather than leaving it for the worker's idle sweep.
          if (!result.duplicate) pokeTrailerNotificationQueue();
          res.status(result.duplicate ? 200 : 201).json(result);
        } catch (e) {
          if (descriptor?.uploadedPaths) await storage.removeObjects(descriptor.uploadedPaths);
          next(e);
        } finally {
          await cleanupFiles(req.file ? [req.file] : []);
        }
      });
    },
  );

  // A wrong payment is reversed, leaving both rows in the ledger.
  router.post(
    '/api/trailer-department/payments/:id/reverse',
    requirePermission('trailer_payments.reverse'),
    asyncRoute(async (req, res) => res.json(
      await db.reverseTrailerPayment(req.params.id, req.body?.reason, actor(req)),
    )),
  );

  router.get(
    '/api/trailer-department/companies/:id/credits',
    requirePermission('trailer_payments.view'),
    asyncRoute(async (req, res) => res.json({
      credits: await db.listCompanyCredits(req.params.id),
    })),
  );

  // Company documents (metadata only; receipts hidden without the permission —
  // ./mediaRoutes.js enforces the same rule again at fetch time).
  router.get(
    '/api/trailer-department/companies/:id/media',
    requirePermission('trailer_payments.view'),
    asyncRoute(async (req, res) => {
      res.json({
        media: await db.listCompanyMedia(
          req.params.id, { includeReceipts: can(req, 'trailer_receipts.view') },
        ),
      });
    }),
  );

  router.get(
    '/api/trailer-department/companies/:id/reminder-history',
    requirePermission('trailer_payments.view'),
    asyncRoute(async (req, res) => {
      res.json({ history: await db.listCompanyReminderHistory(req.params.id) });
    }),
  );

  router.post(
    '/api/trailer-department/credits/:id/apply',
    requirePermission('trailer_payments.record'),
    asyncRoute(async (req, res) => res.json({
      credit: await db.applyCompanyCredit({
        creditId: req.params.id,
        invoiceId: req.body?.invoice_id,
        amount: req.body?.amount,
        actor: actor(req),
      }),
    })),
  );

  router.post(
    '/api/trailer-department/notifications/:id/retry',
    requirePermission('trailer_payments.record', 'trailer_settings.manage'),
    asyncRoute(async (req, res) => {
      const job = await db.retryTrailerNotification(req.params.id);
      if (!job) return res.status(404).json({ error: 'Failed notification not found.' });
      res.json({ job });
    }),
  );

  router.post(
    '/api/trailer-department/invoices/:id/reminder-action',
    requirePermission('trailer_payments.record'),
    asyncRoute(async (req, res) => {
      await db.updateInvoiceReminderState(req.params.id, req.body || {}, actor(req));
      res.json({ updated: true });
    }),
  );

  return router;
}

module.exports = { createTrailerDepartmentAccountingRoutes };
