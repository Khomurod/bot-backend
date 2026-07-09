/**
 * AI reports (HITL drafts) + AI Insights v2 (card-based reports) admin routes.
 *
 * All external collaborators are injected so the test suite's module-cache
 * stubbing of aiAnalysisService / telegramUrl / db / bot keeps working after
 * every fresh require of server/api.js.
 *
 * Routes use their full paths; the router is mounted at the app root so
 * matching behavior is identical to the previous inline definitions.
 */
const express = require('express');

function createAiReportsRoutes({
  db,
  config,
  authMiddleware,
  bot,
  generateDriverReport,
  generateCompanyReport,
  AI_REPORT_GENERATION_FAILED,
  callGroq,
  generateInsightReport,
  ensureAnnotationsForRange,
  buildTelegramMessageUrl,
  renderInsightReportForTelegram,
  sanitizeCompanyReportHtmlForTelegram,
  sendTelegramHtmlChunks,
}) {
  const router = express.Router();

  // ─── AI Reports (HITL) ───
  router.get('/api/ai-reports', authMiddleware, async (req, res) => {
    try {
      const type = req.query.type === 'company' ? 'company' : 'driver';
      const includeSent = req.query.includeSent === 'true';
      let reports;
      if (includeSent) {
        const result = await db.query(
          `SELECT ar.*, COALESCE(g.group_name, 'Global Driver Groups') AS group_name
           FROM ai_reports ar
           LEFT JOIN groups g ON g.id = ar.group_id
           WHERE ar.report_type = $1
           ORDER BY ar.generated_at DESC
           LIMIT 100`,
          [type]
        );
        reports = result.rows;
      } else {
        reports = await db.getPendingAiReports(type);
      }
      res.json(reports);
    } catch (err) {
      console.error('[API] Error fetching AI reports:', err.message);
      res.status(500).json({ error: 'Failed to fetch AI reports' });
    }
  });

  router.post('/api/ai-reports/generate', authMiddleware, async (req, res) => {
    try {
      const reportType = req.body.reportType === 'company' ? 'company' : 'driver';
      const groupId = parseInt(req.body.groupId, 10);
      const daysBack = parseInt(req.body.daysBack, 10);

      if (!Number.isInteger(daysBack) || daysBack < 1 || daysBack > 30) {
        return res.status(400).json({ error: 'daysBack must be an integer between 1 and 30' });
      }

      if (reportType === 'driver' && (!Number.isInteger(groupId) || groupId <= 0)) {
        return res.status(400).json({ error: 'Invalid groupId for driver report' });
      }

      let logs = [];
      let reportText = '';
      let reportGroupId = null;

      if (reportType === 'company') {
        logs = await db.getChatLogsForActiveDriverGroups(daysBack);
      } else {
        const groupRes = await db.query(
          `SELECT id, group_name FROM groups WHERE id = $1 AND group_type = 'driver' AND active = TRUE`,
          [groupId]
        );
        const group = groupRes.rows[0];
        if (!group) {
          return res.status(404).json({ error: 'Group not found' });
        }
        reportGroupId = group.id;
        logs = await db.getChatLogsForGroup(group.id, daysBack);
      }

      if (!logs || logs.length === 0) {
        return res.status(400).json({ error: 'No logs found in the selected date range' });
      }

      // Legacy logs may lack telegram_message_id: omit [Link: ...] but never drop the row.
      const transcriptReadyLogs = logs.map((log) => {
        const link = buildTelegramMessageUrl(log.telegram_group_id, log.telegram_message_id);
        const rawText = log.message_text;
        const messageText = rawText == null || rawText === ''
          ? '(no message text)'
          : String(rawText).replace(/\s+/g, ' ').trim();
        const senderName = String(log.sender_name || 'Unknown');
        const groupName = String(log.group_name || 'Unknown Group');
        const linkPrefix = link ? `[Link: ${link}] ` : '';
        const transcript_line = link
          ? `[Group: ${groupName}] ${linkPrefix}${senderName}: ${messageText}`
          : `[Group: ${groupName}] ${senderName}: ${messageText}`;
        return {
          ...log,
          transcript_line,
        };
      });

      if (reportType === 'company') {
        reportText = await generateCompanyReport(transcriptReadyLogs);
      } else {
        reportText = await generateDriverReport(transcriptReadyLogs);
      }

      if (!reportText || reportText === AI_REPORT_GENERATION_FAILED) {
        return res.status(502).json({ error: 'AI report generation failed' });
      }

      const draft = await db.saveAiReport(reportGroupId, reportText, reportType);
      const hydrated = await db.getAiReportById(draft.id);
      res.status(201).json(hydrated || draft);
    } catch (err) {
      console.error('[API] Error generating AI report:', err.message);
      res.status(500).json({ error: 'Failed to generate AI report' });
    }
  });

  router.post('/api/ai-reports/:id/send', authMiddleware, async (req, res) => {
    try {
      const reportId = parseInt(req.params.id, 10);
      if (!Number.isInteger(reportId) || reportId <= 0) {
        return res.status(400).json({ error: 'Invalid report id' });
      }

      const report = await db.getAiReportById(reportId);
      if (!report) {
        return res.status(404).json({ error: 'Report not found' });
      }
      if (report.status !== 'draft') {
        return res.status(400).json({ error: 'Only draft reports can be sent' });
      }

      const escapeHtml = (text) => String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

      const sourceText = typeof req.body?.editedText === 'string' && req.body.editedText.trim()
        ? req.body.editedText
        : report.report_text;
      let message = '';
      if (report.report_type === 'company') {
        const [overallRaw, breakdownRaw] = String(sourceText || '').split('|||');
        const companyBody = breakdownRaw
          ? `${sanitizeCompanyReportHtmlForTelegram(overallRaw)}\n\n${sanitizeCompanyReportHtmlForTelegram(breakdownRaw)}`
          : sanitizeCompanyReportHtmlForTelegram(sourceText);
        message = [
          '📊 <b>Company AI Weekly Dispatch Report (Admin Approved)</b>',
          `<b>Generated:</b> ${escapeHtml(new Date(report.generated_at).toLocaleString())}`,
          '',
          companyBody || 'Report unavailable.',
        ].join('\n');
      } else {
        const [overallRaw, breakdownRaw] = String(sourceText || '').split('|||');
        const overallSummary = (overallRaw || '').trim() || 'Summary unavailable.';
        const driverBreakdown = (breakdownRaw || '').trim() || 'Driver breakdown unavailable.';
        message = [
          '📊 <b>AI Chat Analysis (Admin Approved)</b>',
          `<b>Group:</b> ${escapeHtml(report.group_name)}`,
          `<b>Generated:</b> ${escapeHtml(new Date(report.generated_at).toLocaleString())}`,
          '',
          `<b>Overall Summary</b>`,
          escapeHtml(overallSummary),
          '',
          `<b>Driver Breakdown</b>`,
          `<blockquote expandable>${escapeHtml(driverBreakdown)}</blockquote>`,
        ].join('\n');
      }

      await sendTelegramHtmlChunks(bot.telegram, config.managementGroupId, message);

      await db.updateAiReportStatus(reportId, 'sent');
      res.json({ success: true });
    } catch (err) {
      const detail = err.response?.description || err.message;
      console.error('[API] Error sending AI report:', detail);
      res.status(500).json({
        error: 'Failed to send AI report to management group',
        detail,
      });
    }
  });

  router.delete('/api/ai-reports/:id', authMiddleware, async (req, res) => {
    try {
      const reportId = parseInt(req.params.id, 10);
      if (!Number.isInteger(reportId) || reportId <= 0) {
        return res.status(400).json({ error: 'Invalid report id' });
      }
      const report = await db.getAiReportById(reportId);
      if (!report) {
        return res.status(404).json({ error: 'Report not found' });
      }
      if (report.status !== 'draft') {
        return res.status(400).json({ error: 'Only draft reports can be discarded' });
      }
      await db.discardAiReport(reportId);
      res.json({ success: true });
    } catch (err) {
      console.error('[API] Error discarding AI report:', err.message);
      res.status(500).json({ error: 'Failed to discard AI report' });
    }
  });

  router.post('/api/ai-reports/test-groq', authMiddleware, async (req, res) => {
    try {
      const output = await callGroq('Reply with exactly: GROQ_OK');
      const ok = output.includes('GROQ_OK');
      res.json({ success: ok, output: output.slice(0, 200) });
    } catch (err) {
      console.error('[API] Groq AI test failed:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ─── AI Insights v2 (card-based reports) ─────────────────────────
  // Generates a brand-new insights report: annotates any missing chat_logs in
  // the window, rebuilds role consensus, computes per-sender stats, runs the
  // nine detectors, and asks Groq for a narrative per non-empty card.
  router.post('/api/ai-insights/generate', authMiddleware, async (req, res) => {
    try {
      const daysBack = parseInt(req.body?.daysBack, 10);
      if (!Number.isInteger(daysBack) || daysBack < 1 || daysBack > 30) {
        return res.status(400).json({ error: 'daysBack must be an integer between 1 and 30' });
      }
      const result = await generateInsightReport({
        daysBack,
        reportType: 'company',
      });
      if (!result.report) {
        return res.status(400).json({ error: result.reason || 'No messages in range to analyze' });
      }
      res.status(201).json({
        report: result.report,
        cards: await db.getInsightsForReport(result.report.id),
        pulse: result.pulse,
      });
    } catch (err) {
      console.error('[API] Insight generation failed:', err.message);
      res.status(500).json({ error: 'Failed to generate insight report', detail: err.message });
    }
  });

  // Lists reports produced by the new insights pipeline (format="insights_v2").
  router.get('/api/ai-insights/reports', authMiddleware, async (req, res) => {
    try {
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
      const rows = await db.query(
        `SELECT id, group_id, report_text, report_type, status, generated_at, sent_at
           FROM ai_reports
          WHERE report_type = 'company'
            AND report_text LIKE '%"format":"insights_v2"%'
          ORDER BY generated_at DESC
          LIMIT $1`,
        [limit]
      );
      res.json(rows.rows.map((r) => {
        let meta = null;
        try { meta = JSON.parse(r.report_text); } catch (_) { /* noop */ }
        return { ...r, meta };
      }));
    } catch (err) {
      console.error('[API] List insights reports failed:', err.message);
      res.status(500).json({ error: 'Failed to list insight reports' });
    }
  });

  // Returns the full card set for a given report.
  router.get('/api/ai-insights/reports/:id', authMiddleware, async (req, res) => {
    try {
      const reportId = parseInt(req.params.id, 10);
      if (!Number.isInteger(reportId) || reportId <= 0) {
        return res.status(400).json({ error: 'Invalid report id' });
      }
      const report = await db.getAiReportById(reportId);
      if (!report) return res.status(404).json({ error: 'Report not found' });
      const cards = await db.getInsightsForReport(reportId);
      let meta = null;
      try { meta = JSON.parse(report.report_text); } catch (_) { /* noop */ }
      res.json({ report, cards, meta });
    } catch (err) {
      console.error('[API] Get insights report failed:', err.message);
      res.status(500).json({ error: 'Failed to load insight report' });
    }
  });

  // Per-card approve / dismiss / edit / feedback.
  router.put('/api/ai-insights/cards/:id', authMiddleware, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid card id' });
      }
      const { status, feedback, patch } = req.body || {};
      const allowed = ['pending', 'approved', 'dismissed', 'edited'];
      if (!allowed.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
      }
      const existing = await db.getInsightById(id);
      if (!existing) return res.status(404).json({ error: 'Card not found' });
      const updated = await db.updateInsightStatus(id, status, feedback || null, patch || null);
      res.json(updated);
    } catch (err) {
      console.error('[API] Update insight card failed:', err.message);
      res.status(500).json({ error: 'Failed to update insight card' });
    }
  });

  // Send the (approved) subset of a report to management group.
  router.post('/api/ai-insights/reports/:id/send', authMiddleware, async (req, res) => {
    try {
      const reportId = parseInt(req.params.id, 10);
      if (!Number.isInteger(reportId) || reportId <= 0) {
        return res.status(400).json({ error: 'Invalid report id' });
      }
      const report = await db.getAiReportById(reportId);
      if (!report) return res.status(404).json({ error: 'Report not found' });
      const allCards = await db.getInsightsForReport(reportId);
      // Include anything not explicitly dismissed — "pending" is treated as OK-to-send
      // to match the live-preview UX. If the user wants stricter behavior, they can
      // approve each card first.
      const cards = allCards.filter((c) => c.status !== 'dismissed');
      if (!cards.length) {
        return res.status(400).json({ error: 'No cards to send (all dismissed)' });
      }
      let meta = {};
      try { meta = JSON.parse(report.report_text); } catch (_) { /* noop */ }
      const html = renderInsightReportForTelegram({
        report,
        cards,
        pulse: meta.pulse || { days_back: meta.days_back || 7 },
      });
      const safe = sanitizeCompanyReportHtmlForTelegram(html);
      await sendTelegramHtmlChunks(bot.telegram, config.managementGroupId, safe);
      await db.updateAiReportStatus(reportId, 'sent');
      for (const c of cards) {
        if (c.status !== 'sent') {
          await db.updateInsightStatus(c.id, 'sent');
        }
      }
      res.json({ success: true, sent_cards: cards.length });
    } catch (err) {
      const detail = err.response?.description || err.message;
      console.error('[API] Send insight report failed:', detail);
      res.status(500).json({ error: 'Failed to send insight report', detail });
    }
  });

  // Manual annotation backfill (for Ask-the-Data freshness).
  router.post('/api/ai-insights/annotate', authMiddleware, async (req, res) => {
    try {
      const daysBack = parseInt(req.body?.daysBack, 10);
      if (!Number.isInteger(daysBack) || daysBack < 1 || daysBack > 90) {
        return res.status(400).json({ error: 'daysBack must be an integer between 1 and 90' });
      }
      const result = await ensureAnnotationsForRange({ daysBack });
      res.json({ success: true, ...result });
    } catch (err) {
      console.error('[API] Annotation backfill failed:', err.message);
      res.status(500).json({ error: 'Annotation backfill failed', detail: err.message });
    }
  });

  return router;
}

module.exports = { createAiReportsRoutes };
