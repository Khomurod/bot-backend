const express = require('express');
const db = require('../../database/db');
const {
  loadAutoMessageConfig,
  previewAutoMessage,
  validateAutoMessagePayload,
  serializeRuleForApi,
  serializeSettingsForApi,
  resolveTemplateAt,
  normalizeTimeString,
} = require('../../services/facebookLeadAutoMessageService');
const {
  listPlaceholders,
  buildTemplateContext,
  renderLeadSmsTemplate,
} = require('../../services/facebookLeadSmsTemplate');
const {
  retryFacebookWebhookEvent,
  getFacebookWebhookLog,
} = require('../../services/facebookWebhookService');

function createFacebookLeadsRouter({ authMiddleware }) {
  const router = express.Router();

  router.get('/auto-messages', authMiddleware, async (req, res) => {
    try {
      const { settings, rules } = await loadAutoMessageConfig();
      const activeNow = settings
        ? resolveTemplateAt({ settings, rules })
        : null;

      let activePreview = null;
      if (settings && activeNow) {
        const sampleFieldMap = {
          full_name: 'Jane Doe',
          phone_number: '+15551234567',
          email: 'jane@example.com',
        };
        const context = buildTemplateContext({
          fieldMap: sampleFieldMap,
          settings,
          pageName: 'Sample Page',
        });
        activePreview = {
          ...activeNow,
          rendered: renderLeadSmsTemplate(activeNow.template, context),
        };
      }

      return res.json({
        settings: serializeSettingsForApi(settings),
        rules: (rules || []).map(serializeRuleForApi),
        placeholders: listPlaceholders(),
        active_now: activePreview,
      });
    } catch (err) {
      console.error('[API] GET facebook-leads/auto-messages failed:', err.message);
      return res.status(500).json({ error: 'Failed to load auto-message settings', detail: err.message });
    }
  });

  router.put('/auto-messages', authMiddleware, async (req, res) => {
    try {
      const body = req.body || {};
      const settingsInput = body.settings || {};
      const rulesInput = Array.isArray(body.rules) ? body.rules : [];

      const settingsPayload = {
        id: settingsInput.id || null,
        timezone: String(settingsInput.timezone || 'America/Chicago').trim(),
        is_enabled: settingsInput.is_enabled !== false,
        rep_name: String(settingsInput.rep_name || 'Tom').trim(),
        company_name: String(settingsInput.company_name || 'Wenze trucking company').trim(),
        position_label: String(settingsInput.position_label || 'OTR position').trim(),
        fallback_template: String(settingsInput.fallback_template || '').trim(),
      };

      const rulesPayload = rulesInput.map((rule, index) => ({
        label: String(rule.label || `Rule ${index + 1}`).trim(),
        days_of_week: Array.isArray(rule.days_of_week)
          ? rule.days_of_week.map((d) => Number(d)).filter((d) => d >= 1 && d <= 7)
          : [1, 2, 3, 4, 5],
        start_time_local: normalizeTimeString(rule.start_time_local || '08:00'),
        end_time_local: normalizeTimeString(rule.end_time_local || '17:00'),
        message_template: String(rule.message_template || '').trim(),
        sort_order: Number.isFinite(rule.sort_order) ? rule.sort_order : index,
        is_active: rule.is_active !== false,
      }));

      const errors = validateAutoMessagePayload({
        settings: settingsPayload,
        rules: rulesPayload,
      });
      if (errors.length) {
        return res.status(400).json({ error: 'Validation failed', details: errors });
      }

      const saved = await db.replaceFacebookLeadAutoMessageConfig({
        settings: settingsPayload,
        rules: rulesPayload,
      });

      const activeNow = resolveTemplateAt({
        settings: saved.settings,
        rules: saved.rules,
      });

      return res.json({
        settings: serializeSettingsForApi(saved.settings),
        rules: saved.rules.map(serializeRuleForApi),
        active_now: activeNow,
      });
    } catch (err) {
      console.error('[API] PUT facebook-leads/auto-messages failed:', err.message);
      return res.status(500).json({ error: 'Failed to save auto-message settings', detail: err.message });
    }
  });

  router.post('/auto-messages/preview', authMiddleware, async (req, res) => {
    try {
      const { settings, rules } = await loadAutoMessageConfig();
      const body = req.body || {};
      const mergedSettings = { ...settings, ...(body.settings || {}) };
      const preview = previewAutoMessage({
        settings: mergedSettings,
        rules: body.rules || rules,
        template: body.template || null,
        fieldMap: body.field_map || body.fieldMap || {
          full_name: 'Jane Doe',
          phone_number: '+15551234567',
          email: 'jane@example.com',
        },
        pageName: body.page_name || body.pageName || '',
        at: body.at || null,
        ruleLabel: body.rule_label || body.ruleLabel || null,
      });

      return res.json({
        rendered: preview.rendered,
        rule_label: preview.ruleLabel,
        source: preview.source,
        segments: preview.segments,
        template: preview.template,
        timezone: preview.timezone,
        timezone_friendly: preview.timezone_friendly,
        evaluated_at_iso: preview.evaluated_at_iso,
      });
    } catch (err) {
      console.error('[API] POST facebook-leads/auto-messages/preview failed:', err.message);
      return res.status(500).json({ error: 'Failed to preview message', detail: err.message });
    }
  });

  router.get('/pages', authMiddleware, async (req, res) => {
    try {
      const pages = await db.listFacebookPageConnectionsAdmin();
      return res.json({ pages });
    } catch (err) {
      console.error('[API] GET facebook-leads/pages failed:', err.message);
      return res.status(500).json({ error: 'Failed to load connected pages', detail: err.message });
    }
  });

  router.get('/webhook-log', authMiddleware, async (req, res) => {
    try {
      const limit = Number(req.query.limit) || 50;
      const entries = await getFacebookWebhookLog(limit);
      return res.json({ count: entries.length, entries });
    } catch (err) {
      console.error('[API] GET facebook-leads/webhook-log failed:', err.message);
      return res.status(500).json({ error: 'Failed to load webhook log', detail: err.message });
    }
  });

  router.post('/webhook-log/:id/retry', authMiddleware, async (req, res) => {
    try {
      const event = await retryFacebookWebhookEvent(req.params.id);
      if (!event) {
        return res.status(404).json({ error: 'No webhook event found for that identifier' });
      }
      return res.json({ success: true, event });
    } catch (err) {
      console.error('[API] POST facebook-leads/webhook-log retry failed:', err.message);
      return res.status(500).json({ error: 'Failed to retry webhook event', detail: err.message });
    }
  });

  return router;
}

module.exports = { createFacebookLeadsRouter };
