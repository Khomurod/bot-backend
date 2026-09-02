/**
 * Trailer Department — documents and photos: the upload endpoint, the
 * short-lived signed URL, and the per-invoice / per-company metadata listings.
 *
 * THE RECEIPT RULE is the reason these four endpoints are one module. Payment
 * receipts are visible only to `trailer_receipts.view`, and that is enforced
 * TWICE — the listings omit receipt rows, and the signed-url endpoint refuses a
 * receipt again at fetch time — so an id leaked from an older response still
 * cannot be exchanged for bytes. Keeping both halves in one file is what makes
 * the pair reviewable.
 *
 * Bytes are never returned here; only metadata and signed URLs.
 *
 * GET /companies/:id/media applies the same receipt rule but lives in
 * ./accountingRoutes.js, where it was registered: endpoint ORDER is asserted by
 * tests/trailerDepartmentRouteWiring.test.js, and preserving it exactly was
 * worth more than moving one listing here for tidiness.
 *
 * Split out of server/routes/trailerDepartmentRoutes.js.
 */
'use strict';

const express = require('express');
const storage = require('../../../services/trailerStorageService');
const { upload, asyncRoute, actor, can, storeFile, cleanupFiles } = require('./shared');

const UPLOADABLE_MEDIA_TYPES = [
  'pickup_condition_photo', 'return_condition_photo', 'damage_photo',
  'agreement_document', 'invoice_document', 'other_rental_document',
];

function createTrailerDepartmentMediaRoutes({ db, requirePermission }) {
  const router = express.Router();

  router.post(
    '/api/trailer-department/media',
    requirePermission('trailer_inspections.manage', 'trailer_payments.record'),
    (req, res, next) => {
      upload.array('files', 10)(req, res, async (uploadError) => {
        if (uploadError) return next(Object.assign(uploadError, { status: 400 }));
        const created = [];
        try {
          if (!req.files?.length) {
            return res.status(400).json({ error: 'At least one file is required.' });
          }
          const mediaType = req.body.media_type;
          if (!UPLOADABLE_MEDIA_TYPES.includes(mediaType)) {
            return res.status(400).json({ error: 'Invalid media type.' });
          }

          // Item-scoped uploads: verify the agreement item exists (and matches the
          // agreement when both are given) so photos can never attach to nothing.
          let agreementId = req.body.agreement_id || null;
          const rentalItemId = req.body.rental_item_id || null;
          if (rentalItemId) {
            const item = await db.getItemById(rentalItemId);
            if (!item || (agreementId && Number(item.agreement_id) !== Number(agreementId))) {
              return res.status(404).json({ error: 'Rental item not found.' });
            }
            agreementId = agreementId || item.agreement_id;
          }

          for (const file of req.files) {
            const descriptor = await storeFile(
              file,
              mediaType,
              rentalItemId || req.body.rental_id || req.body.trailer_id || 'unassigned',
              { actor: actor(req) },
            );
            // A failed metadata insert must not leave the bytes behind.
            try {
              created.push(await db.createTrailerMedia({
                ...descriptor,
                mediaType,
                trailerId: req.body.trailer_id,
                rentalId: req.body.rental_id,
                agreementId,
                rentalItemId,
                inspectionId: req.body.inspection_id,
                invoiceId: req.body.invoice_id,
                uploadedByAdminId: req.admin.id,
                notes: req.body.notes,
              }));
            } catch (e) {
              await storage.removeObjects(descriptor.uploaded);
              throw e;
            }
          }
          res.status(201).json({ media: created });
        } catch (e) {
          next(e);
        } finally {
          await cleanupFiles(req.files);
        }
      });
    },
  );

  // A short-lived URL the browser (or Telegram) can fetch. Works for BOTH
  // backends: Supabase mints its own signed URL, while a database-backed file
  // gets an HMAC-signed link to /api/trailer-media/:id. Never a permanent or
  // unsigned public URL, and the resulting URL is never logged.
  router.get(
    '/api/trailer-department/media/:id/signed-url',
    requirePermission('trailers.view', 'trailer_receipts.view'),
    asyncRoute(async (req, res) => {
      const media = await db.getTrailerMedia(req.params.id);
      if (!media) return res.status(404).json({ error: 'Media not found.' });
      if (media.media_type === 'payment_receipt' && !can(req, 'trailer_receipts.view')) {
        return res.status(403).json({ error: 'Receipt permission required.' });
      }
      res.json({
        url: await storage.buildSignedMediaUrl(media, { preview: req.query.preview === 'true' }),
        expires_in: storage.DEFAULT_TTL_SECONDS,
      });
    }),
  );

  // Documents/receipts attached to one invoice — metadata only, never bytes.
  // Receipt rows are hidden from callers without the receipt permission; the
  // signed-url route above enforces the same rule again at fetch time.
  router.get(
    '/api/trailer-department/invoices/:id/media',
    requirePermission('trailer_payments.view'),
    asyncRoute(async (req, res) => {
      res.json({
        media: await db.listInvoiceMedia(
          req.params.id, { includeReceipts: can(req, 'trailer_receipts.view') },
        ),
      });
    }),
  );

  return router;
}

module.exports = { createTrailerDepartmentMediaRoutes };
