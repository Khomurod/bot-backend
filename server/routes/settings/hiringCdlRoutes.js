'use strict';

/**
 * Settings → Safety Approvals → "6. CDL → Bitrix fields" — where each item
 * read off a candidate's CDL goes in Bitrix (owner, 14 November 2026;
 * docs/architecture/hiring-cdl-reading.md).
 *
 *   GET  /hiring-cdl               the CDL items, the saved mapping, and how the
 *                                  latest reads ended (counts and statuses —
 *                                  never a value: none is stored)
 *   POST /hiring-cdl/bitrix-fields the live field lists, read ON DEMAND from
 *                                  Bitrix (`crm.contact.fields`,
 *                                  `crm.deal.fields` — read only), cut to the
 *                                  fields a value can be written to
 *   PUT  /hiring-cdl               save the whole mapping (`{ mapping: [...] }`)
 *
 * A Bitrix that cannot be read answers 200 with `ok: false` and Bitrix's own
 * words — the request worked; what failed is the thing being asked. The
 * webhook URL never appears.
 */

const express = require('express');

const fieldMap = require('../../../database/hiringStages/cdlFieldMap');
const { listRecentReads } = require('../../../database/hiringStages/cdlReads');
const { CDL_ITEMS } = require('../../../lib/hiringStages/cdlFields');
const { normaliseMapping, offerableFields } = require('../../../lib/hiringStages/cdlWrite');
const { stripUrls } = require('../../../lib/security/redactUrls');
const { readFieldLists } = require('../../../services/hiringStages/cdlBitrix');
const { sendFailure } = require('../../middleware/failureResponse');

const LOG = { logPrefix: '[SETTINGS API]' };

function createHiringCdlSettingsRouter({ authMiddleware }) {
  const router = express.Router();

  router.get('/hiring-cdl', authMiddleware, async (req, res) => {
    try {
      const [mapping, recent] = await Promise.all([fieldMap.getFieldMap(), listRecentReads(10).catch(() => [])]);
      return res.json({
        items: CDL_ITEMS.map(({ key, label }) => ({ key, label })),
        mapping,
        recent: recent.map((r) => ({
          id: r.id,
          status: r.status,
          providerKey: r.providerKey,
          model: r.model,
          itemsWritten: r.itemsWritten,
          itemsInComment: r.itemsInComment,
          nameFromCdl: r.nameFromCdl,
          dealId: r.dealId,
          createdAt: r.createdAt,
        })),
      });
    } catch (err) {
      return sendFailure(res, err, { message: 'Failed to load the CDL field mapping', ...LOG });
    }
  });

  router.post('/hiring-cdl/bitrix-fields', authMiddleware, async (req, res) => {
    try {
      const lists = await readFieldLists();
      return res.json({
        ok: true,
        contact: offerableFields('contact', lists.contact),
        deal: offerableFields('deal', lists.deal),
      });
    } catch (err) {
      if (err?.name === 'BitrixError') return res.json({ ok: false, error: stripUrls(String(err.message)).slice(0, 300) });
      return sendFailure(res, err, { message: 'Failed to read the Bitrix fields', ...LOG });
    }
  });

  router.put('/hiring-cdl', authMiddleware, async (req, res) => {
    const checked = normaliseMapping(req.body?.mapping);
    if (!checked.ok) return res.status(400).json({ error: checked.error });
    try {
      const mapping = await fieldMap.saveFieldMap(checked.mapping, { updatedBy: req.admin?.username || null });
      return res.json({ mapping });
    } catch (err) {
      return sendFailure(res, err, { message: 'Failed to save the CDL field mapping', ...LOG });
    }
  });

  return router;
}

module.exports = { createHiringCdlSettingsRouter };
