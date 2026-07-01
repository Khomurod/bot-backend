import React, { useState, useEffect, useCallback } from "react";
import * as api from "../api";

export default function RoastPage() {
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState({
    enabled: false,
    groupId: "",
    targetUsername: "",
    aiInstructions: "",
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState(null);
  const [confirmSend, setConfirmSend] = useState(false);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getRoastSettings();
      setSettings(data);
      setForm({
        enabled: !!data.enabled,
        groupId: data.groupId ?? "",
        targetUsername: data.targetUsername || "",
        aiInstructions: data.aiInstructions || "",
      });
    } catch (err) {
      setStatus({ type: "error", text: err.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setStatus(null);
    try {
      const updated = await api.updateRoastSettings(form);
      setSettings(updated);
      setStatus({
        type: "success",
        text: updated.enabled
          ? "Roast feature is ON. The bot will reply in the configured group."
          : "Roast feature is OFF. The bot will stay silent.",
      });
    } catch (err) {
      setStatus({ type: "error", text: err.message });
    } finally {
      setSaving(false);
    }
  };

  const handleSendNow = async () => {
    setSending(true);
    setStatus(null);
    try {
      const result = await api.sendRoastNow();
      setStatus({ type: "success", text: `Sent: "${result.message}"` });
    } catch (err) {
      setStatus({ type: "error", text: err.message });
    } finally {
      setSending(false);
    }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>😏 Roast Bot</h2>
          <p>
            AI-powered Uzbek roast replies in one employee group. Witty and
            intelligent only — never rude or vulgar.
          </p>
        </div>
      </div>

      {status && <div className={`alert alert-${status.type}`} style={{ marginBottom: 20 }}>{status.text}</div>}

      {loading ? (
        <div className="loading"><div className="spinner"></div> Loading...</div>
      ) : (
        <div className="card" style={{ marginBottom: 24 }}>
          <form onSubmit={handleSave}>
            <div className="form-group">
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) => setForm((s) => ({ ...s, enabled: e.target.checked }))}
                />
                Enable roast feature
              </label>
              <p style={{ fontSize: 13, color: "var(--text-secondary, #888)", marginTop: 4 }}>
                When on, the bot replies with a witty Uzbek roast whenever someone
                replies to one of its messages or @-mentions it in the group below.
              </p>
            </div>

            <div className="form-group">
              <label>Group ID (numeric Telegram chat id, e.g. -1003802484933)</label>
              <input
                className="form-input"
                value={form.groupId}
                onChange={(e) => setForm((s) => ({ ...s, groupId: e.target.value }))}
                placeholder="-1003802484933"
              />
            </div>

            <div className="form-group">
              <label>Target username (singled out by name in roasts, without @)</label>
              <input
                className="form-input"
                value={form.targetUsername}
                onChange={(e) => setForm((s) => ({ ...s, targetUsername: e.target.value }))}
                placeholder="Ellaaccounting"
              />
            </div>

            <div className="form-group">
              <label>AI tone instructions</label>
              <textarea
                className="form-input"
                rows={3}
                value={form.aiInstructions}
                onChange={(e) => setForm((s) => ({ ...s, aiInstructions: e.target.value }))}
              />
            </div>

            <button className="btn btn-primary" type="submit" disabled={saving}>
              {saving ? "Saving..." : "Save settings"}
            </button>
          </form>

          <div style={{ marginTop: 20, paddingTop: 20, borderTop: "1px solid var(--border)" }}>
            <button
              className="btn btn-ghost"
              type="button"
              onClick={() => setConfirmSend(true)}
              disabled={sending || !settings?.groupId}
            >
              {sending ? "Sending..." : "Send a roast now"}
            </button>
          </div>
        </div>
      )}

      {confirmSend && (
        <div className="confirm-overlay" onClick={() => setConfirmSend(false)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>😏 Send a roast now?</h3>
            <p>
              This immediately posts an AI-written Uzbek roast tagging
              @{form.targetUsername || "the target user"} in the configured group.
            </p>
            <div className="confirm-actions">
              <button className="btn btn-ghost" onClick={() => setConfirmSend(false)}>Cancel</button>
              <button
                className="btn btn-primary"
                onClick={async () => {
                  setConfirmSend(false);
                  await handleSendNow();
                }}
              >
                Send
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
