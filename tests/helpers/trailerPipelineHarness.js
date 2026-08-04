/**
 * Shared harness for the trailer semantic-pipeline tests.
 *
 * Loads services/trailerMonitorService with its db, vision service and AI
 * semantic verifier stubbed via require.cache, so the REAL approval gate and
 * the REAL collected context are exercised without env, network or a database.
 *
 * Extracted from tests/trailerSemanticPipeline.test.js to keep that file within
 * the 500-line limit (CLAUDE.md -> Maximum source-file size).
 */
'use strict';

const path = require('node:path');

// Stub targets stay written relative to the tests/ directory, as they were
// before this harness moved into tests/helpers/.
const TESTS_DIR = path.resolve(__dirname, '..');

const monitorPath = path.resolve(TESTS_DIR, '../services/trailerMonitorService.js');
const contextPath = path.resolve(TESTS_DIR, '../services/trailerContextService.js');
const verifierPath = path.resolve(TESTS_DIR, '../services/trailerSemanticVerifier.js');
const visionPath = path.resolve(TESTS_DIR, '../services/trailerVisionService.js');
const dbPath = path.resolve(TESTS_DIR, '../database/db.js');
const detectionPath = path.resolve(TESTS_DIR, '../services/trailerMasterList/detection.js');
const { purgeTrailerMonitorModules } = require('./trailerMonitorCache');

/**
 * Load the monitor with:
 *  - a fake db (records events/status updates),
 *  - a fake vision service (photo → configured units, no network),
 *  - the REAL semantic verifier module except verifyTrailerSemantics, which
 *    returns `aiResult` ('unavailable' when none given) — the REAL approval
 *    gate still runs against the REAL collected context.
 */
function loadPipeline({ aiResult, settings = {}, forceDuplicate = false, visionUnitsByFileId = {} } = {}) {
  const state = { events: [], statusUpdates: [], queries: [], instructions: [], unmatchedMentions: [] };
  const fakeDb = {
    insertTrailerPendingInstruction: async (input) => {
      const instruction = { id: state.instructions.length + 1, instruction_status: 'pending', ...input };
      state.instructions.push(instruction);
      return { instruction, duplicate: false };
    },
    getLatestPendingInstruction: async () => null,
    markPendingInstructionConfirmed: async (id, opts) => ({ id, ...opts }),
    getTrailerSettings: async () => ({
      enabled: true, beta_mode: true, automatic_update_test_group_id: null,
      send_driver_group_confirmation: true, send_reaction: true,
      ai_fallback_enabled: true, geocoding_enabled: false,
      semantic_ai_required: true, auto_register_confidence: 92, review_confidence: 75,
      ...settings,
    }),
    getDriverProfileByGroupId: async () => ({ id: 5, first_name: 'John', last_name: 'Driver' }),
    // A detection RESOLVES against the authoritative master list and can never
    // create a trailer. Default: the unit is a known ACTIVE OFFICIAL trailer, so
    // known-trailer ingestion behaves exactly as before.
    resolveTrailerByUnitOrAlias: async (unit) => (unit
      ? { trailer: { id: 100, unit_number: unit }, official: true, matchedBy: 'unit_number', normalizedUnit: unit }
      : { trailer: null, official: false, matchedBy: null, normalizedUnit: null }),
    recordUnmatchedMention: async (evidence) => {
      state.unmatchedMentions.push(evidence);
      return { id: state.unmatchedMentions.length, ...evidence };
    },
    getTrailerByUnitNumber: async (unit) => (unit ? { id: 100, unit_number: unit } : null),
    getTrailerCurrentStatus: async () => null,
    insertTrailerEvent: async (input) => {
      if (forceDuplicate) return { event: { id: 1, ...input }, duplicate: true };
      const event = { id: state.events.length + 1, ...input };
      state.events.push(event);
      return { event, duplicate: false };
    },
    applyEventToCurrentStatus: async (trailer, event) => { state.statusUpdates.push({ trailer, event }); return {}; },
    query: async (sql, params) => { state.queries.push({ sql, params }); return { rows: [], rowCount: 0 }; },
  };

  const fakeVision = {
    photoDescriptor: (message) => {
      if (!message) return null;
      if (Array.isArray(message.photo) && message.photo.length) {
        const largest = message.photo[message.photo.length - 1];
        return { fileId: largest.file_id, fileUniqueId: largest.file_unique_id || null };
      }
      return null;
    },
    extractTrailerUnitsFromTelegramImage: async (_tg, { fileId, source }) => {
      const units = visionUnitsByFileId[fileId];
      if (!units) return null;
      return { trailerUnits: units.map((u) => ({ ...u, source })), visibleText: null, aiModel: 'test-vision' };
    },
    isVisionConfigured: () => true,
  };

  // Real verifier (for the gate + normalization), with the AI call mocked.
  // Every module that captured a collaborator at require time must be purged
  // with the monitor — including its stage modules and detection, which capture
  // `db`. Otherwise one stays bound to a previous test's fake db and quietly
  // records into the wrong state. See the helper for why this purges by
  // directory rather than by list.
  purgeTrailerMonitorModules([monitorPath, contextPath, verifierPath, detectionPath]);
  require.cache[dbPath] = { exports: fakeDb };
  require.cache[visionPath] = { exports: fakeVision };
  const realVerifier = require(verifierPath);
  const calls = { verify: 0 };
  require.cache[verifierPath] = {
    exports: {
      ...realVerifier,
      isSemanticAiConfigured: () => aiResult !== undefined,
      verifyTrailerSemantics: async (context, det, opts) => {
        calls.verify += 1;
        calls.lastContext = context;
        if (aiResult === undefined) return { status: 'unavailable' };
        if (typeof aiResult === 'function') return aiResult(context, det, opts);
        return aiResult;
      },
    },
  };
  delete require.cache[monitorPath];
  const mod = require(monitorPath);
  return { mod, state, calls };
}

module.exports = { loadPipeline };
