import React, { useState } from "react";
import { timeAgo, friendlyTimezone } from "../utils/formatTime";
import { useAutoMessages } from "./facebookLeads/useAutoMessages";
import { useLeadsInfrastructure } from "./facebookLeads/useLeadsInfrastructure";
import { AutoMessagesTab } from "./facebookLeads/AutoMessagesTab";
import { ConnectedPagesTab } from "./facebookLeads/ConnectedPagesTab";
import { WebhookLogTab } from "./facebookLeads/WebhookLogTab";
import { ResetConfirmDialog } from "./facebookLeads/ResetConfirmDialog";

/**
 * Customer Inquiries — page container.
 *
 * LAYOUT AND WIRING ONLY. State and API calls live in the two hooks:
 *
 *   ./facebookLeads/useAutoMessages.js         rules, fallback, both previews, save
 *   ./facebookLeads/useLeadsInfrastructure.js  connected Pages + the webhook log
 *
 * They are separate because they load at different times: the auto-message
 * config is fetched on mount, while the Pages list and the 50-row event log
 * are fetched only when their tab is opened.
 *
 * The Activity Log stays behind ?dev=1 — it exposes queue internals meant for
 * diagnosing a missed lead — and the tab list is filtered by the same flag, so
 * it cannot be reached by clicking either.
 */
export default function FacebookLeadsPage() {
  const isDev = new URLSearchParams(window.location.search).get('dev') === '1';
  const [tab, setTab] = useState("auto");
  const [status, setStatus] = useState(null);

  const auto = useAutoMessages(setStatus);
  const infra = useLeadsInfrastructure(tab, setStatus);

  const { pages, activePages, recentEvents, webhookLog, logLoading } = infra;
  const { nowPreview, previewTarget, rules, timezone, loading } = auto;

  const nowSubtitle = nowPreview?.evaluated_at_iso
    ? `Based on current time in ${friendlyTimezone(timezone)}. Evaluated ${timeAgo(nowPreview.evaluated_at_iso)}.`
    : `Based on current time in ${friendlyTimezone(timezone)}. Uses your unsaved draft rules below.`;

  const editingLabel = previewTarget.kind === "fallback"
    ? "Fallback (outside hours)"
    : (rules[previewTarget.index]?.label || `Rule ${previewTarget.index + 1}`);

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" /> Loading Customer Inquiries settings...
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <h2>👥 Customer Inquiries</h2>
        <p>Manage automated responses for new customer inquiries from Facebook ads.</p>
      </div>

      {/* ─── Summary Cards ─── */}
      <div className="summary-cards">
        <div className="summary-card">
          <div className="summary-card-value">{pages.length}</div>
          <div className="summary-card-label">Connected Pages</div>
        </div>
        <div className="summary-card">
          <div className="summary-card-value">{activePages.length}</div>
          <div className="summary-card-label">Active Pages</div>
        </div>
        <div className="summary-card">
          <div className="summary-card-value">{rules.length}</div>
          <div className="summary-card-label">Time Rules</div>
        </div>
        <div className="summary-card">
          <div className="summary-card-value">{recentEvents.length}</div>
          <div className="summary-card-label">Events (7 days)</div>
        </div>
      </div>

      {status && (
        <div className={`alert alert-${status.type === "error" ? "error" : "success"}`} style={{ marginBottom: 16 }}>
          {status.text}
        </div>
      )}

      {/* ─── Tabs ─── */}
      <div className="broadcast-tabs" style={{ marginBottom: 24 }}>
        {[
          { id: "auto", label: "Auto-Reply Setup" },
          { id: "pages", label: "Connected Pages" },
          ...(isDev ? [{ id: "log", label: "Activity Log" }] : []),
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            className={`broadcast-tab-btn ${tab === t.id ? "active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "auto" && auto.settings && (
        <AutoMessagesTab {...auto} nowSubtitle={nowSubtitle} editingLabel={editingLabel} />
      )}

      {tab === "pages" && <ConnectedPagesTab pages={pages} />}

      {isDev && tab === "log" && (
        <WebhookLogTab
          webhookLog={webhookLog}
          logLoading={logLoading}
          loadWebhookLog={infra.loadWebhookLog}
          handleRetry={infra.handleRetry}
        />
      )}

      {auto.showResetConfirm && (
        <ResetConfirmDialog
          setShowResetConfirm={auto.setShowResetConfirm}
          confirmReset={auto.confirmReset}
        />
      )}
    </div>
  );
}
