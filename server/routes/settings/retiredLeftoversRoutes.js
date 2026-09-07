/**
 * Retired feature leftovers — admin API.
 *
 * Removing a feature from the code does not remove its tables or its permission
 * rows, and deliberately so: a deploy must never destroy history. This is the
 * separate, deliberate step that clears what is left, driven by an
 * administrator who can see exactly what will go.
 *
 * TWO ENDPOINTS, TWO DIFFERENT WEIGHTS:
 *
 *   POST /retired-leftovers/purge-config   role and permission rows, and
 *                                          deactivating accounts that hold only
 *                                          retired roles. Reversible.
 *   POST /retired-leftovers/drop-tables    permanently destroys the rows in the
 *                                          selected tables. Not reversible
 *                                          without a database backup.
 *
 * The drop therefore requires an exact typed confirmation phrase, the same
 * discipline the SOS clear-real/clear-test operations used. The phrase is
 * returned by GET so the UI can show it, and compared here — a request without
 * it is refused before any SQL runs. Group keys are validated against the
 * hard-coded list in database/retiredLeftovers.js; a table name never travels
 * from a request into SQL.
 *
 * Split out of server/routes/settingsRoutes.js.
 */

const express = require('express');
const leftovers = require('../../../database/retiredLeftovers');
const { sendFailure } = require('../../middleware/failureResponse');

/**
 * What the operator must type to authorise a drop. Deliberately not "yes" or
 * "confirm": it has to be a sentence nobody types by reflex, and it names the
 * thing that cannot be undone.
 */
const DROP_CONFIRMATION_PHRASE = 'DELETE RETIRED DATA PERMANENTLY';

function normalizeGroupKeys(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const keys = [...new Set(list.map((k) => String(k || '').trim()).filter(Boolean))];
  if (!keys.length) {
    throw Object.assign(new Error('Select at least one group to remove.'), { status: 400 });
  }
  const unknown = keys.filter((k) => !leftovers.isKnownGroup(k));
  if (unknown.length) {
    throw Object.assign(
      new Error(`Unknown leftover group: ${unknown.join(', ')}`),
      { status: 400 },
    );
  }
  return keys;
}

function createRetiredLeftoversRouter({ authMiddleware }) {
  const router = express.Router();

  router.get('/retired-leftovers', authMiddleware, async (req, res) => {
    try {
      const inventory = await leftovers.getLeftoverInventory();
      res.json({
        ...inventory,
        confirmation_phrase: DROP_CONFIRMATION_PHRASE,
      });
    } catch (err) {
      sendFailure(res, err, {
        message: 'Failed to read retired-feature leftovers',
        logPrefix: '[LEFTOVERS]',
      });
    }
  });

  router.post('/retired-leftovers/purge-config', authMiddleware, async (req, res) => {
    try {
      const result = await leftovers.purgeRetiredRbac({ actorId: req.admin?.id ?? null });
      console.log(
        `[LEFTOVERS] config purged by admin=${req.admin?.id ?? 'unknown'}: `
        + `${result.deleted_roles.length} role(s), ${result.deleted_permissions.length} permission(s), `
        + `${result.deactivated_accounts.length} account(s) deactivated`,
      );
      res.json(result);
    } catch (err) {
      sendFailure(res, err, {
        message: 'Failed to remove the retired role and permission rows',
        logPrefix: '[LEFTOVERS]',
      });
    }
  });

  router.post('/retired-leftovers/drop-tables', authMiddleware, async (req, res) => {
    try {
      const body = req.body || {};
      // The confirmation is checked BEFORE the group keys are even read, so a
      // request that forgot it cannot learn anything from the response either.
      if (String(body.confirm || '') !== DROP_CONFIRMATION_PHRASE) {
        return res.status(400).json({
          error: `Type "${DROP_CONFIRMATION_PHRASE}" to confirm. This permanently deletes the stored rows.`,
          code: 'CONFIRMATION_REQUIRED',
        });
      }
      const groupKeys = normalizeGroupKeys(body.groups);
      const result = await leftovers.dropRetiredTables({
        groupKeys,
        actorId: req.admin?.id ?? null,
      });
      console.log(
        `[LEFTOVERS] tables dropped by admin=${req.admin?.id ?? 'unknown'} `
        + `for ${groupKeys.join(', ')}: ${result.dropped.length} dropped, `
        + `${result.already_absent.length} already absent, ${result.blocked.length} blocked`,
      );
      return res.json(result);
    } catch (err) {
      if (err.status === 400) return res.status(400).json({ error: err.message });
      return sendFailure(res, err, {
        message: 'Failed to drop the retired tables',
        logPrefix: '[LEFTOVERS]',
      });
    }
  });

  return router;
}

module.exports = { createRetiredLeftoversRouter, DROP_CONFIRMATION_PHRASE };
