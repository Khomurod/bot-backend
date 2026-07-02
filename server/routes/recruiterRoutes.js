const express = require('express');
const rc = require('../../database/ringcentral');
const { syncNow } = require('../../services/recruiterCallSyncService');

/**
 * Recruiter call-KPI API.
 *   GET    /            → list recruiters (1:1 name ↔ RingCentral number)
 *   POST   /            → create recruiter
 *   PUT    /:id         → update recruiter
 *   DELETE /:id         → delete recruiter
 *   POST   /sync        → run a RingCentral call-log sync now (optional ?full=1)
 *   GET    /stats?date= → per-recruiter daily KPIs vs targets
 */
function createRecruiterRouter({ authMiddleware }) {
  const router = express.Router();

  router.get('/', authMiddleware, async (req, res) => {
    try {
      const recruiters = await rc.listRecruiters({ includeInactive: true });
      res.json({ recruiters });
    } catch (err) {
      console.error('[RECRUITER API] list failed:', err.message);
      res.status(500).json({ error: 'Failed to load recruiters' });
    }
  });

  router.post('/', authMiddleware, async (req, res) => {
    try {
      const recruiter = await rc.createRecruiter({
        name: req.body?.name,
        phoneNumber: req.body?.phoneNumber,
        active: req.body?.active,
      });
      res.json({ recruiter });
    } catch (err) {
      if (/unique/i.test(err.message) || err.code === '23505') {
        return res.status(409).json({ error: 'That phone number is already assigned to a recruiter.' });
      }
      console.error('[RECRUITER API] create failed:', err.message);
      res.status(400).json({ error: err.message });
    }
  });

  router.put('/:id', authMiddleware, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid id' });
      const recruiter = await rc.updateRecruiter(id, {
        name: req.body?.name,
        phoneNumber: req.body?.phoneNumber,
        active: req.body?.active,
      });
      if (!recruiter) return res.status(404).json({ error: 'Recruiter not found' });
      res.json({ recruiter });
    } catch (err) {
      if (/unique/i.test(err.message) || err.code === '23505') {
        return res.status(409).json({ error: 'That phone number is already assigned to a recruiter.' });
      }
      console.error('[RECRUITER API] update failed:', err.message);
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/:id', authMiddleware, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid id' });
      await rc.deleteRecruiter(id);
      res.json({ deleted: true });
    } catch (err) {
      console.error('[RECRUITER API] delete failed:', err.message);
      res.status(500).json({ error: 'Failed to delete recruiter' });
    }
  });

  router.post('/sync', authMiddleware, async (req, res) => {
    try {
      const full = req.query.full === '1' || req.body?.full === true;
      const result = await syncNow({ full });
      res.json(result);
    } catch (err) {
      console.error('[RECRUITER API] sync failed:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  router.get('/stats', authMiddleware, async (req, res) => {
    try {
      const cfg = await rc.getRcConfig();
      const stats = await rc.getRecruiterStats(req.query.date || null, cfg);
      res.json(stats);
    } catch (err) {
      console.error('[RECRUITER API] stats failed:', err.message);
      res.status(500).json({ error: 'Failed to load recruiter stats' });
    }
  });

  return router;
}

module.exports = { createRecruiterRouter };
