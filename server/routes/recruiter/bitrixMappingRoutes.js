/**
 * Mapping recruiters to Bitrix users, from the admin panel.
 *
 *   GET  /bitrix-users    → the Bitrix user directory, for a picker instead of
 *                           hunting ids in profile URLs
 *   POST /bitrix-automap  → match recruiters to Bitrix users; previews by
 *                           default, writes only when { apply: true }
 *
 * Both are admin-guarded. Neither ever returns the Bitrix webhook URL — the
 * URL is the credential, so only its host leaves the server.
 *
 * Split out of ../recruiterRoutes.js, which registers these.
 */
const {
  previewRecruiterBitrixMapping,
  applyRecruiterBitrixMapping,
  FAILURE_MESSAGES,
} = require('../../../services/recruiterBitrixMapping');
const {
  fetchBitrixUsers,
  webhookHost,
} = require('../../../services/recruiterBitrixMapping/directory');

function registerRecruiterBitrixMappingRoutes(router, { authMiddleware }) {
  router.get('/bitrix-users', authMiddleware, async (req, res) => {
    try {
      const directory = await fetchBitrixUsers();
      if (!directory.ok) {
        return res.json({
          ok: false,
          reason: directory.reason,
          message: FAILURE_MESSAGES[directory.reason] || 'Could not read the Bitrix user directory.',
          detail: directory.detail || null,
          users: [],
        });
      }
      // Only what a picker needs to identify a person. Phone numbers are
      // matched server-side and never have to reach the browser to do it.
      return res.json({
        ok: true,
        bitrixHost: webhookHost(),
        users: directory.users.map(({ id, fullName, email, position, active }) => ({
          id, fullName, email, position, active,
        })),
      });
    } catch (err) {
      console.error('[RECRUITER API] Bitrix user directory failed:', err.message);
      return res.status(502).json({ error: 'Could not read the Bitrix user directory' });
    }
  });

  router.post('/bitrix-automap', authMiddleware, async (req, res) => {
    const apply = req.body?.apply === true;
    try {
      const result = apply
        ? await applyRecruiterBitrixMapping({ confirm: req.body?.confirm })
        : await previewRecruiterBitrixMapping();
      // A directory that could not be read is a reportable outcome, not a
      // crash: the panel renders `message` instead of an error banner.
      return res.json({ applied: [], failed: [], ...result, mode: apply ? 'apply' : 'preview' });
    } catch (err) {
      console.error('[RECRUITER API] Bitrix automap failed:', err.message);
      return res.status(500).json({ error: 'Bitrix mapping failed' });
    }
  });
}

module.exports = { registerRecruiterBitrixMappingRoutes };
