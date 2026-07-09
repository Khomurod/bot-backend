/**
 * Driver profile admin routes: canonical profile listing, manual edits, and the
 * AI sync/parse actions — plus the read-only BOL/POD intake status surface.
 *
 * Routes use their full paths; the router is mounted at the app root so
 * matching behavior is identical to the previous inline definitions.
 */
const express = require('express');
const { listCanonicalDriverGroups } = require('../../services/driverGroupDirectoryService');
const { runUnifiedDriverGroupAiSync } = require('../../services/driverGroupAiSyncService');
const driverProfileAiParser = require('../../services/driverProfileAiParser');

function mapDriverProfileForApi(profile) {
  if (!profile) return null;
  return {
    id: profile.profile_id || profile.id,
    group_id: profile.group_id,
    group_name: profile.group_name,
    telegram_group_id: profile.telegram_group_id,
    first_name: profile.first_name || null,
    last_name: profile.last_name || null,
    secondary_first_name: profile.secondary_first_name || null,
    secondary_last_name: profile.secondary_last_name || null,
    full_name: profile.full_name || profile.display_name || null,
    display_name: profile.display_name || profile.full_name || null,
    normalized_driver_key: profile.normalized_driver_key || null,
    driver_type: profile.driver_type || 'owner',
    status: profile.status || 'active',
    telegram_username: profile.telegram_username || null,
    telegram_user_id: profile.telegram_user_id != null ? String(profile.telegram_user_id) : null,
    unit_number: profile.unit_number || null,
    language: profile.language || 'en',
    date_of_birth: profile.date_of_birth || null,
    date_of_start: profile.date_of_start || null,
    needs_review: profile.needs_review === true,
    backfill_confidence: profile.backfill_confidence,
    status_source: profile.status_source || null,
    first_name_source: profile.first_name_source || null,
    last_name_source: profile.last_name_source || null,
    secondary_first_name_source: profile.secondary_first_name_source || null,
    secondary_last_name_source: profile.secondary_last_name_source || null,
    driver_type_source: profile.driver_type_source || null,
    unit_number_source: profile.unit_number_source || null,
    duplicate_group_count: profile.duplicate_group_count || 1,
    duplicate_group_ids: profile.duplicate_group_ids || [],
    duplicate_active_group_ids: profile.duplicate_active_group_ids || [],
    duplicate_inactive_group_ids: profile.duplicate_inactive_group_ids || [],
    duplicate_conflict: profile.duplicate_conflict === true,
    duplicate_resolution: profile.duplicate_resolution || 'unique',
    duplicate_review_required: profile.duplicate_review_required === true,
    suppressed_duplicate: profile.suppressed_duplicate === true,
    canonical_group_id: profile.canonical_group_id || profile.group_id,
    created_at: profile.profile_created_at || profile.created_at,
    updated_at: profile.profile_updated_at || profile.updated_at,
  };
}

const DRIVER_PROFILE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function createDriverProfilesRoutes({ db, config, authMiddleware }) {
  const router = express.Router();

  router.get('/api/driver-profiles', authMiddleware, async (req, res) => {
    try {
      const includeInactive = req.query.include_inactive !== 'false';
      const needsReviewOnly = req.query.needs_review_only === 'true';
      await db.listDriverProfiles({ includeInactive: true });
      let rows = await listCanonicalDriverGroups({ operational: false, includeNonDrivers: false });
      if (!includeInactive) {
        rows = rows.filter((row) => row.inactive !== true);
      }
      if (needsReviewOnly) {
        rows = rows.filter((row) => row.needs_review === true || row.duplicate_review_required === true);
      }
      res.json(rows.map(mapDriverProfileForApi));
    } catch (err) {
      console.error('[API] Error fetching driver profiles:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Smart BOL/POD intake — read-only status/ops surface: whether the feature is
  // on, dry-run vs live, AI/Datatruck readiness, and recent detected batches
  // (waiting/uploaded/ignored/failed/duplicate). Supportable without overbuilding.
  router.get('/api/datatruck-docs/status', authMiddleware, async (req, res) => {
    try {
      const telegramDocs = require('../../database/telegramDocuments');
      const datatruck = require('../../services/datatruckApiService');
      const classifier = require('../../services/documentClassifierService');
      const [counts, recent] = await Promise.all([
        telegramDocs.batchStatusCounts().catch(() => ({})),
        telegramDocs.listRecentBatches(50).catch(() => []),
      ]);
      res.json({
        feature: {
          intakeEnabled: config.datatruckDocUploadEnabled,
          mode: config.datatruckDocUploadDryRun ? 'dry_run' : 'live',
          batchWaitSeconds: config.datatruckDocIntakeBatchWaitSeconds,
          maxFiles: config.datatruckDocIntakeMaxFiles,
          maxFileMb: config.datatruckDocIntakeMaxFileMb,
          // Confirmation buttons are group-open (no approver list).
          confirmationButtons: 'group-open',
        },
        services: {
          datatruckConfigured: datatruck.isConfigured(),
          aiClassifierConfigured: classifier.isConfigured(),
          forwardingEnabled: config.datatruckDocDeliveryEnabled,
        },
        counts,
        recentBatches: (recent || []).map((b) => ({
          id: b.id,
          status: b.status,
          doc_type: b.detected_doc_type,
          load: b.datatruck_load_reference,
          match_confidence: b.match_confidence,
          ai_confidence: b.confidence,
          files: Number(b.file_count) || 0,
          created_at: b.created_at,
          updated_at: b.updated_at,
        })),
      });
    } catch (err) {
      console.error('[API] datatruck-docs status error:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  router.put('/api/driver-profiles/:id', authMiddleware, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid driver profile id' });
      }

      const body = req.body || {};
      const allowedTypes = ['owner', 'company_driver'];
      const allowedStatuses = ['active', 'inactive'];
      const allowedLanguages = ['en', 'ru', 'uz'];

      if (body.driver_type != null && !allowedTypes.includes(body.driver_type)) {
        return res.status(400).json({ error: 'driver_type must be owner or company_driver' });
      }
      if (body.status != null && !allowedStatuses.includes(body.status)) {
        return res.status(400).json({ error: 'status must be active or inactive' });
      }
      if (body.language != null && !allowedLanguages.includes(body.language)) {
        return res.status(400).json({ error: 'language must be en, ru, or uz' });
      }
      if (
        body.backfill_confidence != null
        && (!Number.isInteger(body.backfill_confidence)
          || body.backfill_confidence < 0
          || body.backfill_confidence > 100)
      ) {
        return res.status(400).json({ error: 'backfill_confidence must be an integer between 0 and 100' });
      }

      for (const key of ['date_of_birth', 'date_of_start']) {
        const value = body[key];
        if (value == null || value === '') continue;
        if (typeof value !== 'string' || !DRIVER_PROFILE_DATE_RE.test(value)) {
          return res.status(400).json({ error: `${key} must be YYYY-MM-DD or null` });
        }
        const d = new Date(value);
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({ error: `${key} is not a valid calendar date` });
        }
      }

      // Telegram user ids can exceed 2^53, so accept a number or digit string
      // and pass it through as a string (null / '' clears the selection).
      if (
        body.telegram_user_id != null
        && body.telegram_user_id !== ''
        && !/^[1-9]\d*$/.test(String(body.telegram_user_id).trim())
      ) {
        return res.status(400).json({ error: 'telegram_user_id must be a positive integer or null' });
      }
      if (
        body.telegram_username != null
        && body.telegram_username !== ''
        && !/^@?[A-Za-z0-9_]{3,32}$/.test(String(body.telegram_username).trim())
      ) {
        return res.status(400).json({ error: 'telegram_username must be 3–32 characters: letters, numbers, or underscore' });
      }

      const patch = {
        ...(Object.prototype.hasOwnProperty.call(body, 'first_name') ? { first_name: body.first_name } : {}),
        ...(Object.prototype.hasOwnProperty.call(body, 'last_name') ? { last_name: body.last_name } : {}),
        ...(Object.prototype.hasOwnProperty.call(body, 'secondary_first_name') ? { secondary_first_name: body.secondary_first_name } : {}),
        ...(Object.prototype.hasOwnProperty.call(body, 'secondary_last_name') ? { secondary_last_name: body.secondary_last_name } : {}),
        ...(Object.prototype.hasOwnProperty.call(body, 'driver_type') ? { driver_type: body.driver_type } : {}),
        ...(Object.prototype.hasOwnProperty.call(body, 'status') ? { status: body.status } : {}),
        ...(Object.prototype.hasOwnProperty.call(body, 'unit_number') ? { unit_number: body.unit_number } : {}),
        ...(Object.prototype.hasOwnProperty.call(body, 'language') ? { language: body.language } : {}),
        ...(Object.prototype.hasOwnProperty.call(body, 'date_of_birth')
          ? { date_of_birth: body.date_of_birth || null }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(body, 'date_of_start')
          ? { date_of_start: body.date_of_start || null }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(body, 'needs_review') ? { needs_review: body.needs_review } : {}),
        ...(Object.prototype.hasOwnProperty.call(body, 'backfill_confidence') ? { backfill_confidence: body.backfill_confidence } : {}),
        ...(Object.prototype.hasOwnProperty.call(body, 'telegram_user_id')
          ? { telegram_user_id: body.telegram_user_id || null }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(body, 'telegram_username')
          ? { telegram_username: body.telegram_username || null }
          : {}),
      };

      const updated = await db.updateDriverProfile(id, patch);
      if (!updated) {
        return res.status(404).json({ error: 'Driver profile not found' });
      }
      res.json(mapDriverProfileForApi(updated));
    } catch (err) {
      console.error('[API] Error updating driver profile:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  router.post('/api/driver-profiles/ai-sync', authMiddleware, async (req, res) => {
    try {
      const apply = req.query.apply !== 'false' && req.body?.apply !== false;
      const result = await runUnifiedDriverGroupAiSync({ apply });
      res.json(result);
    } catch (err) {
      console.error('[API] Driver profile AI sync failed:', err.message);
      res.status(500).json({ error: 'AI sync failed', detail: err.message });
    }
  });

  // POST /api/driver-profiles/ai-parse — AI reads each driver group name and
  // derives unit number, first/last name, and driver_type (company_driver if the
  // name marks it, else owner). With ?apply=true (or body.apply), the proposals are
  // written to the profiles; otherwise they are returned as a preview.
  router.post('/api/driver-profiles/ai-parse', authMiddleware, async (req, res) => {
    try {
      const apply = req.query.apply === 'true' || req.body?.apply === true;
      const profiles = await db.listDriverProfiles({ includeInactive: true });
      const groups = profiles.map((p) => ({ id: p.group_id, group_name: p.group_name }));
      const parsed = await driverProfileAiParser.parseGroups(groups);

      const profileByGroupId = new Map(profiles.map((p) => [Number(p.group_id), p]));
      const proposals = [];
      let updated = 0;

      for (const row of parsed) {
        const profile = profileByGroupId.get(Number(row.group_id));
        if (!profile) continue;
        const proposal = {
          group_id: row.group_id,
          profile_id: profile.id,
          group_name: row.group_name,
          current: {
            first_name: profile.first_name || null,
            last_name: profile.last_name || null,
            unit_number: profile.unit_number || null,
            driver_type: profile.driver_type || 'owner',
          },
          proposed: {
            first_name: row.first_name || null,
            last_name: row.last_name || null,
            unit_number: row.unit_number || null,
            driver_type: row.driver_type || 'owner',
          },
          source: row.source,
        };
        const changed = ['first_name', 'last_name', 'unit_number', 'driver_type']
          .some((k) => (proposal.current[k] || null) !== (proposal.proposed[k] || null));
        proposal.changed = changed;
        proposals.push(proposal);

        if (apply && changed) {
          await db.updateDriverProfile(profile.id, {
            first_name: row.first_name,
            last_name: row.last_name,
            unit_number: row.unit_number,
            driver_type: row.driver_type,
            needs_review: !(row.first_name && row.unit_number),
          });
          updated += 1;
        }
      }

      res.json({ applied: apply, total: proposals.length, updated, proposals });
    } catch (err) {
      console.error('[API] Driver profile AI parse failed:', err.message);
      res.status(500).json({ error: 'AI parse failed', detail: err.message });
    }
  });

  return router;
}

module.exports = { createDriverProfilesRoutes };
