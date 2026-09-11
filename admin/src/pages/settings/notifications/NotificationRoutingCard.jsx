import React from "react";

import * as api from "../../../api";

/**
 * AI & Operations notifications — the one screen that answers "where do Wenze's
 * alerts go?".
 *
 * Before this you could only answer it by reading the source: five features had
 * five destinations spread across three tables and the environment, and one of
 * them had silently discarded 101 staff alerts for months because a minus sign
 * was dropped when it was typed in.
 *
 * So the screen is built around that failure. One default group, overrides only
 * where an operator actually wants the traffic split, every id proven before it
 * is trusted, and a "not configured" state that says out loud that nothing will
 * be delivered rather than looking like an empty field.
 */
function Row({ category, value, onChange, onBlur, onPreview, busy, fallbackConfigured }) {
  const usingDefault = !String(value ?? "").trim();
  return (
    <div style={{ borderTop: "1px solid rgba(148,163,184,0.2)", padding: "10px 0" }}>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 260px", minWidth: 0 }}>
          <strong>{category.label}</strong>
          {category.humanActionUsually && (
            <span
              title="Someone normally has to do something about these."
              style={{
                marginLeft: 8, fontSize: 11, padding: "1px 6px", borderRadius: 999,
                background: "rgba(234,179,8,0.18)", color: "#a16207",
              }}
            >
              needs a person
            </span>
          )}
          <div className="muted" style={{ marginTop: 4 }}>{category.what}</div>
        </div>
        <div style={{ flex: "0 1 260px" }}>
          <input
            type="text"
            inputMode="numeric"
            placeholder="Same as the default group"
            value={value ?? ""}
            onChange={(e) => onChange(e.target.value)}
            onBlur={onBlur}
            style={{ width: "100%" }}
          />
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            {usingDefault
              ? (fallbackConfigured
                ? "Goes to the default group."
                : "⚠ No default group — these will not be sent.")
              : "Goes to its own group."}
          </div>
        </div>
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPreview(category.key)}
          title="Send one real notice of this kind so you can see where it lands"
        >
          Send an example
        </button>
      </div>
    </div>
  );
}

export default function NotificationRoutingCard({ flash }) {
  const [data, setData] = React.useState(null);
  const [form, setForm] = React.useState({ defaultChatId: "", categoryChatIds: {} });
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [suggestion, setSuggestion] = React.useState(null);

  const apply = React.useCallback((payload) => {
    setData(payload);
    setForm({
      defaultChatId: payload.settings?.defaultChatId ?? "",
      categoryChatIds: { ...(payload.settings?.categoryChatIds || {}) },
    });
  }, []);

  const load = React.useCallback(async () => {
    try {
      apply(await api.getNotificationSettings());
      setError(null);
    } catch (err) {
      setError(err.message || "Could not load the notification settings.");
    } finally {
      setLoading(false);
    }
  }, [apply]);

  React.useEffect(() => { load(); }, [load]);

  async function save(patch) {
    setBusy(true);
    setSuggestion(null);
    try {
      const settings = await api.updateNotificationSettings(patch);
      setData((d) => ({ ...d, settings }));
      setError(null);
      flash?.("success", "Saved.");
    } catch (err) {
      // The route hands back the corrected id when a minus sign was dropped.
      setSuggestion(err?.suggestion || null);
      setError(err.message || "Could not save.");
      flash?.("error", err.message || "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    try {
      const out = await api.testNotificationChat(form.defaultChatId);
      flash?.(out.ok ? "success" : "error",
        out.ok ? `Sent to ${out.chatId}.` : (out.error || "Could not send."));
    } catch (err) {
      flash?.("error", err.message);
    } finally {
      setBusy(false);
    }
  }

  async function preview(category) {
    setBusy(true);
    try {
      const out = await api.previewNotification(category);
      flash?.(out.delivered ? "success" : "error",
        out.delivered ? "Sent — check the chat." : `Not sent: ${out.reason}.`);
    } catch (err) {
      flash?.("error", err.message);
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <div className="card"><h3>🔔 AI &amp; Operations notifications</h3><p>Loading…</p></div>;
  }

  const categories = data?.categories || [];
  const queue = data?.queue || null;
  const defaultConfigured = Boolean(String(form.defaultChatId ?? "").trim());

  return (
    <div className="card">
      <h3>🔔 AI &amp; Operations notifications</h3>
      <p className="muted">
        Where Wenze sends what it notices. Set one group for everything, and give a
        category its own group only when you want that traffic separated.
      </p>

      {error && <p className="error">{error}</p>}
      {suggestion && (
        <p className="error">
          Did you mean <code>{suggestion}</code>?{" "}
          <button
            type="button"
            className="btn btn-sm"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setForm((f) => ({ ...f, defaultChatId: suggestion }));
              save({ defaultChatId: suggestion });
            }}
          >
            Use it
          </button>
        </p>
      )}

      <label style={{ display: "block", marginTop: 12 }}>
        <strong>Default group</strong>
        <input
          type="text"
          inputMode="numeric"
          placeholder="e.g. -1001234567890"
          value={form.defaultChatId ?? ""}
          onChange={(e) => setForm((f) => ({ ...f, defaultChatId: e.target.value }))}
          onBlur={() => {
            if ((data?.settings?.defaultChatId ?? "") !== (form.defaultChatId ?? "")) {
              save({ defaultChatId: form.defaultChatId });
            }
          }}
          style={{ width: "100%", maxWidth: 320, display: "block", marginTop: 4 }}
        />
      </label>
      <div style={{ marginTop: 6 }}>
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy || !defaultConfigured}
          onMouseDown={(e) => e.preventDefault()}
          onClick={test}
        >
          Send a test message
        </button>
        {!defaultConfigured && (
          <span className="muted" style={{ marginLeft: 8 }}>
            ⚠ Nothing is being sent anywhere until this is set.
          </span>
        )}
      </div>

      <h4 style={{ marginTop: 20, marginBottom: 0 }}>Send these somewhere else</h4>
      {categories.map((c) => (
        <Row
          key={c.key}
          category={c}
          busy={busy}
          fallbackConfigured={defaultConfigured}
          value={form.categoryChatIds?.[c.key]}
          onChange={(v) => setForm((f) => ({
            ...f, categoryChatIds: { ...f.categoryChatIds, [c.key]: v },
          }))}
          onBlur={() => {
            const next = form.categoryChatIds?.[c.key] ?? "";
            const stored = data?.settings?.categoryChatIds?.[c.key] ?? "";
            if (next !== stored) save({ categoryChatIds: { [c.key]: next } });
          }}
          onPreview={preview}
        />
      ))}

      {queue && (
        <p className="muted" style={{ marginTop: 14, fontSize: 12 }}>
          Delivery: {queue.delivered24h} sent in the last 24 hours, {queue.pending} waiting
          {queue.abandoned > 0 && (
            <strong style={{ color: "#b91c1c" }}> , {queue.abandoned} gave up after retrying</strong>
          )}.
        </p>
      )}
    </div>
  );
}
