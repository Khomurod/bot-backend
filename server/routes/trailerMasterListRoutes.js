/**
 * Trailer master-list authority — HTTP routes.
 *
 * The master-list snapshot import, its reconciliation review, aliases, and the
 * unmatched Telegram mention queue.
 *
 * No business logic here: routes validate input, enforce permissions, and hand
 * off to services/trailerMasterList (orchestration) and
 * database/trailerMasterList (transactions). Kept out of trailerRoutes.js,
 * which is already near the file-size limit.
 *
 * The rule these endpoints exist to protect: a trailer may join the master list
 * ONLY through an approved import or permission-gated manual creation. Nothing
 * here creates a trailer as a side effect — creation always requires an
 * explicit, separate, authorized action.
 */
'use strict';

const express = require('express');
const multer = require('multer');
const os = require('node:os');
const crypto = require('node:crypto');

const db = require('../../database/db');
const { stageSnapshot, buildReconciliation, limits } = require('../../services/trailerMasterList');
const { safeFilename } = require('../../services/trailerImageService');

/**
 * DISK storage, never memoryStorage: the whole official trailer list can arrive
 * as a dozen photos and this runs on a memory-constrained instance. The ingest
 * layer reads them back one at a time.
 */
function buildUploader() {
  const { maxImages, maxBytesPerImage } = limits();
  return multer({
    storage: multer.diskStorage({
      destination: os.tmpdir(),
      filename: (_req, file, cb) => cb(null, `trailer-master-${crypto.randomUUID()}-${safeFilename(file.originalname)}`),
    }),
    limits: { fileSize: maxBytesPerImage, files: maxImages },
  });
}

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const actor = (req) => ({ ...req.admin, ipAddress: req.ip });

function createTrailerMasterListRoutes({ authMiddleware, requirePermission }) {
  const router = express.Router();
  const upload = buildUploader();
  const base = '/api/trailer-master-list';

  router.use(base, authMiddleware);

  // ─── snapshot import ───

  /**
   * Upload the complete official trailer list as photos. Stages only: nothing
   * reaches `trailers` until the reviewer confirms and reconciles.
   */
  router.post(`${base}/imports`, requirePermission('trailer_imports.manage'), (req, res, next) => {
    upload.array('images', limits().maxImages)(req, res, async (uploadError) => {
      if (uploadError) {
        // multer's own limit errors are the user's problem to fix, not a 500.
        return next(Object.assign(uploadError, { status: 400 }));
      }
      try {
        const result = await stageSnapshot(req.files, { actor: actor(req) });
        res.status(201).json(result);
      } catch (error) {
        next(error);
      }
    });
  });

  router.get(`${base}/imports`, requirePermission('trailer_imports.manage'), asyncRoute(async (req, res) => {
    res.json(await db.listImportBatches({ ...req.query, import_kind: 'master_snapshot' }));
  }));

  router.get(`${base}/imports/:id`, requirePermission('trailer_imports.manage'), asyncRoute(async (req, res) => {
    const batch = await db.getImportBatchById(req.params.id);
    if (!batch) return res.status(404).json({ error: 'Import not found.' });
    res.json({ batch, rows: await db.listImportRows(req.params.id) });
  }));

  /** Reviewer edits to a staged row, before approval. Staging only. */
  router.put(`${base}/imports/:id/rows/:rowId`, requirePermission('trailer_imports.manage'), asyncRoute(async (req, res) => {
    const row = await db.updateImportRow(req.params.rowId, req.body || {}, { actor: actor(req) });
    if (!row) return res.status(404).json({ error: 'Import row not found.' });
    res.json({ row });
  }));

  /**
   * Confirm these photos ARE the complete official list. Required before
   * reconciliation, because it is what makes "missing from the snapshot"
   * meaningful rather than an artefact of a partial upload.
   */
  router.post(`${base}/imports/:id/confirm`, requirePermission('trailer_imports.manage'), asyncRoute(async (req, res) => {
    res.json({ batch: await db.confirmSnapshotBatch(req.params.id, { actor: actor(req) }) });
  }));

  /** The four review groups: matched / new / missing / conflicting. Read-only. */
  router.get(`${base}/imports/:id/reconciliation`, requirePermission('trailer_imports.manage'), asyncRoute(async (req, res) => {
    res.json(await buildReconciliation(req.params.id));
  }));

  /**
   * Apply the reviewer's approved decisions, atomically. Archiving and merging
   * additionally require their own permissions — reviewing an import is not
   * authority to retire assets.
   */
  router.post(`${base}/imports/:id/reconcile`, requirePermission('trailer_imports.manage'), asyncRoute(async (req, res) => {
    const decisions = Array.isArray(req.body?.decisions) ? req.body.decisions : [];
    const held = new Set(req.admin?.permissions || []);
    const required = { archive: 'trailers.archive', merge: 'trailers.merge', create: 'trailers.create' };
    for (const decision of decisions) {
      const permission = required[decision.decision];
      if (permission && !held.has(permission)) {
        return res.status(403).json({ error: `The "${decision.decision}" decision requires ${permission}.` });
      }
    }
    res.json(await db.applyReconciliation(req.params.id, decisions, { actor: actor(req) }));
  }));

  // ─── unmatched Telegram mentions ───

  router.get(`${base}/mentions`, requirePermission('trailer_unmatched_mentions.manage'), asyncRoute(async (req, res) => {
    res.json(await db.listUnmatchedMentions(req.query));
  }));

  router.get(`${base}/mentions/count`, requirePermission('trailer_unmatched_mentions.manage'), asyncRoute(async (_req, res) => {
    res.json({ pending: await db.countPendingMentions() });
  }));

  /**
   * Resolve a mention: link / ignore / mark false detection.
   *
   * Deliberately CANNOT create a trailer. Creating one from this queue is a
   * separate, explicit action against the trailer-creation endpoint with
   * trailers.create — recorded here afterwards as review_status='created'.
   */
  router.post(`${base}/mentions/:id/resolve`, requirePermission('trailer_unmatched_mentions.manage'), asyncRoute(async (req, res) => {
    const body = req.body || {};
    if (body.review_status === 'created' && !new Set(req.admin?.permissions || []).has('trailers.create')) {
      return res.status(403).json({ error: 'Creating a trailer from a mention requires trailers.create.' });
    }
    res.json({ mention: await db.resolveUnmatchedMention(req.params.id, body, { actor: actor(req) }) });
  }));

  // ─── aliases ───

  router.get(`${base}/trailers/:id/aliases`, requirePermission('trailers.view'), asyncRoute(async (req, res) => {
    res.json({ aliases: await db.listTrailerAliases(req.params.id) });
  }));

  router.post(`${base}/trailers/:id/aliases`, requirePermission('trailers.edit'), asyncRoute(async (req, res) => {
    const alias = await db.createTrailerAlias(
      { ...req.body, trailer_id: req.params.id },
      { actor: actor(req) },
    );
    res.status(201).json({ alias });
  }));

  router.delete(`${base}/aliases/:id`, requirePermission('trailers.edit'), asyncRoute(async (req, res) => {
    const alias = await db.deactivateTrailerAlias(req.params.id);
    if (!alias) return res.status(404).json({ error: 'Alias not found.' });
    res.json({ alias });
  }));

  router.use((error, _req, res, _next) => {
    console.error('[TRAILER-MASTER-LIST]', error.message);
    const status = error.status || (error.code === '23505' ? 409 : 500);
    res.status(status).json({
      error: status === 500 ? 'Master-list request failed.' : error.message,
      code: error.code && status !== 500 ? error.code : undefined,
    });
  });

  return router;
}

module.exports = { createTrailerMasterListRoutes };
