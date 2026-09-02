import { useState, useEffect } from "react";
import * as api from "../../api";

/**
 * The connected Facebook Pages and the verified-webhook event log.
 *
 * Both are fetched LAZILY when their tab is opened rather than on mount: the
 * event log is a 50-row query and the page list hits Meta, and neither is
 * needed by the auto-message tab that opens first.
 *
 * Retry is safe to press twice — the server's queue dedupes on event_key — but
 * it still confirms, because a re-queued lead means a second outbound SMS to a
 * real person if the first one had in fact gone out.
 *
 * Split out of admin/src/pages/FacebookLeadsPage.jsx.
 */
export function useLeadsInfrastructure(tab, setStatus) {
  const [pages, setPages] = useState([]);
  const [webhookLog, setWebhookLog] = useState([]);
  const [logLoading, setLogLoading] = useState(false);

  const loadPages = async () => {
    try {
      const data = await api.getFacebookLeadPages();
      setPages(data.pages || []);
    } catch (err) {
      setStatus({ type: "error", text: err.message });
    }
  };

  const loadWebhookLog = async () => {
    setLogLoading(true);
    try {
      const data = await api.getFacebookLeadWebhookLog(50);
      setWebhookLog(data.entries || []);
    } catch (err) {
      setStatus({ type: "error", text: err.message });
    } finally {
      setLogLoading(false);
    }
  };

  useEffect(() => {
    if (tab === "pages") loadPages();
    if (tab === "log") loadWebhookLog();
  }, [tab]);

  const handleRetry = async (id) => {
    if (!window.confirm("Re-queue this webhook event for processing?")) return;
    try {
      await api.retryFacebookLeadWebhookEvent(id);
      setStatus({ type: "success", text: "Event queued for retry." });
      loadWebhookLog();
    } catch (err) {
      setStatus({ type: "error", text: err.message });
    }
  };

  const activePages = pages.filter((p) => p.is_active);
  const recentEvents = webhookLog.filter((e) => {
    if (!e.created_at) return false;
    const diff = Date.now() - new Date(e.created_at).getTime();
    return diff < 7 * 24 * 60 * 60 * 1000;
  });

  return {
    pages, activePages, webhookLog, recentEvents, logLoading,
    loadPages, loadWebhookLog, handleRetry,
  };
}
