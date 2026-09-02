'use strict';

/**
 * Trailer Tracking (Beta) — the data-access package.
 *
 * This feature is a driver-responsibility ledger, and the package is layered so
 * that shape is visible in the require graph:
 *
 *   status.js              pure vocabulary — what possession/cargo/"official" mean
 *   list.js                the admin master list joined to current status
 *   events.js              the immutable, deduped, human-reviewable event ledger
 *   currentStatus.js       status DERIVED from that ledger, never written directly
 *   pendingInstructions.js planned pickup/drop-off — instructions, not events
 *   importBatches.js       screenshot-import staging
 *   settings.js            the single settings row
 *
 * Dependencies flow one way: events -> currentStatus -> status. Nothing here
 * requires db.js, so the graph stays acyclic.
 *
 * Trailer Tracking is a SEPARATE feature from the Trailer Department (rental and
 * asset management, database/trailerAgreements + services/trailerMasterList).
 * The master list itself is owned by ./trailerMasterList and only re-exported
 * here, because a trailer may never be created from a detection.
 *
 * Add new code to the module that owns the table and export it from here;
 * database/trailers.js only forwards.
 */

// The single owner of unit-number normalization, shared with the master-list
// and Telegram ingest paths so matching can never drift between them.
const { normalizeUnitNumber } = require('../../lib/trailers/normalize');
// The master list (reads + the single restricted creation path).
const masterTrailers = require('../trailerMasterList/masterTrailers');
// Kept in its own module for the size budget; part of the tracking surface.
const { listTrailerMapData } = require('../trailerMapData');

const status = require('./status');
const list = require('./list');
const events = require('./events');
const currentStatus = require('./currentStatus');
const pendingInstructions = require('./pendingInstructions');
const importBatches = require('./importBatches');
const settings = require('./settings');

module.exports = {
  normalizeUnitNumber,
  // trailers (master list — owned by ./trailerMasterList)
  getTrailerById: masterTrailers.getTrailerById,
  getTrailerByUnitNumber: masterTrailers.getTrailerByUnitNumber,
  upsertTrailerByUnitNumber: masterTrailers.upsertTrailerByUnitNumber,
  ensureTrailerForDetection: masterTrailers.ensureTrailerForDetection,
  listTrailers: list.listTrailers,
  // events
  insertTrailerEvent: events.insertTrailerEvent,
  getTrailerEventById: events.getTrailerEventById,
  updateTrailerEvent: events.updateTrailerEvent,
  acceptTrailerEvent: events.acceptTrailerEvent,
  declineTrailerEvent: events.declineTrailerEvent,
  listTrailerEvents: events.listTrailerEvents,
  listTrailerTimeline: events.listTrailerTimeline,
  listUnidentifiedTrailerEvents: events.listUnidentifiedTrailerEvents,
  resolveTrailerEvent: events.resolveTrailerEvent,
  listTrailerEventsNeedingGeocode: events.listTrailerEventsNeedingGeocode,
  setTrailerEventGeocode: events.setTrailerEventGeocode,
  // current status
  applyEventToCurrentStatus: currentStatus.applyEventToCurrentStatus,
  recomputeTrailerCurrentStatus: currentStatus.recomputeTrailerCurrentStatus,
  recomputeAllTrailerCurrentStatuses: currentStatus.recomputeAllTrailerCurrentStatuses,
  getTrailerReviewContext: currentStatus.getTrailerReviewContext,
  getTrailerCurrentStatus: currentStatus.getTrailerCurrentStatus,
  listTrailerMapData,
  // unified state
  getUnifiedTrailerStates: currentStatus.getUnifiedTrailerStates,
  getUnifiedTrailerStateById: currentStatus.getUnifiedTrailerStateById,
  listTrailersNeedingReview: currentStatus.listTrailersNeedingReview,
  buildDisplayStatus: status.buildDisplayStatus,
  derivePossessionCargo: status.derivePossessionCargo,
  // pending instructions (planned pickup/drop-off)
  insertTrailerPendingInstruction: pendingInstructions.insertTrailerPendingInstruction,
  getLatestPendingInstruction: pendingInstructions.getLatestPendingInstruction,
  markPendingInstructionConfirmed: pendingInstructions.markPendingInstructionConfirmed,
  setPendingInstructionStatus: pendingInstructions.setPendingInstructionStatus,
  listPendingInstructions: pendingInstructions.listPendingInstructions,
  // import
  createImportBatch: importBatches.createImportBatch,
  insertImportRows: importBatches.insertImportRows,
  getImportBatch: importBatches.getImportBatch,
  listImportBatches: importBatches.listImportBatches,
  markImportBatchCommitted: importBatches.markImportBatchCommitted,
  // settings
  getTrailerSettings: settings.getTrailerSettings,
  updateTrailerSettings: settings.updateTrailerSettings,
  markTrailerSettingsGroupTested: settings.markTrailerSettingsGroupTested,
};
