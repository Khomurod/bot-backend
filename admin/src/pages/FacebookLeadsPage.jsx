import React, { useState, useEffect, useCallback, useRef } from "react";
import * as api from "../api";

const WEEKDAYS = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 7, label: "Sun" },
];

const TIMEZONES = [
  "America/Chicago",
  "America/New_York",
  "America/Denver",
  "America/Los_Angeles",
  "America/Phoenix",
  "UTC",
];

function emptyRule(sortOrder = 0) {
  return {
    label: `Rule ${sortOrder + 1}`,
    days_of_week: [1, 2, 3, 4, 5],
    start_time_local: "08:00",
    end_time_local: "17:00",
    message_template: (
      "Hello {first_name}, this is {rep_name} with {company_name} "
      + "and thanks for applying to our {position}. "
      + "Can I call you right now to explain the details?"
    ),
    sort_order: sortOrder,
    is_active: true,
  };
}

function PlaceholderChips({ placeholders, onInsert }) {
  if (!placeholders?.length) return null;
  return (
    <div className="placeholder-chips" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
      {placeholders.map((p) => (
        <button
          key={p.key}
          type="button"
          className="btn btn-secondary"
          style={{ fontSize: 12, padding: "4px 10px" }}
          title={p.description}
          onClick={() => onInsert(`{${p.key}}`)}
        >
          {`{${p.key}}`}
        </button>
      ))}
    </div>
  );
}

export default function FacebookLeadsPage() {
  const [tab, setTab] = useState("auto");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null);

  const [settings, setSettings] = useState(null);
  const [rules, setRules] = useState([]);
  const [placeholders, setPlaceholders] = useState([]);
  const [activeNow, setActiveNow] = useState(null);

  const [sampleLead, setSampleLead] = useState({
    full_name: "Jane Doe",
    phone_number: "+15551234567",
    email: "jane@example.com",
  });
  const [previewText, setPreviewText] = useState("");
  const [previewMeta, setPreviewMeta] = useState(null);

  const [pages, setPages] = useState([]);
  const [webhookLog, setWebhookLog] = useState([]);
  const [logLoading, setLogLoading] = useState(false);

  const focusRef = useRef({ type: "fallback", index: null });
  const fallbackRef = useRef(null);
  const ruleRefs = useRef({});

  const setFocus = (type, index = null) => {
    focusRef.current = { type, index };
  };

  const insertPlaceholder = (token) => {
    const { type, index } = focusRef.current;
    if (type === "fallback" && fallbackRef.current) {
      const el = fallbackRef.current;
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      const next = el.value.slice(0, start) + token + el.value.slice(end);
      setSettings((s) => ({ ...s, fallback_template: next }));
      return;
    }
    if (type === "rule" && index != null) {
      setRules((prev) => prev.map((r, i) => {
        if (i !== index) return r;
        const el = ruleRefs.current[index];
        const current = r.message_template || "";
        if (!el) {
          return { ...r, message_template: current + token };
        }
        const start = el.selectionStart ?? current.length;
        const end = el.selectionEnd ?? current.length;
        return { ...r, message_template: current.slice(0, start) + token + current.slice(end) };
      }));
    }
  };

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getFacebookLeadAutoMessages();
      setSettings(data.settings || {
        timezone: "America/Chicago",
        is_enabled: true,
        rep_name: "Tom",
        company_name: "Wenze trucking company",
        position_label: "OTR position",
        fallback_template: "",
      });
      setRules(data.rules?.length ? data.rules : [emptyRule(0)]);
      setPlaceholders(data.placeholders || []);
      setActiveNow(data.active_now || null);
    } catch (err) {
      setStatus({ type: "error", text: err.message });
    } finally {
      setLoading(false);
    }
  }, []);

  const runPreview = useCallback(async () => {
    if (!settings) return;
    try {
      const result = await api.previewFacebookLeadAutoMessage({
        settings,
        rules,
        field_map: sampleLead,
      });
      setPreviewText(result.rendered || "");
      setPreviewMeta({
        rule_label: result.rule_label,
        segments: result.segments,
        source: result.source,
      });
    } catch (err) {
      setPreviewText("");
      setPreviewMeta({ error: err.message });
    }
  }, [settings, rules, sampleLead]);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    const t = setTimeout(() => { void runPreview(); }, 400);
    return () => clearTimeout(t);
  }, [runPreview]);

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

  const handleSave = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const payload = {
        settings,
        rules: rules.map((r, i) => ({ ...r, sort_order: i })),
      };
      const saved = await api.saveFacebookLeadAutoMessages(payload);
      setSettings(saved.settings);
      setRules(saved.rules?.length ? saved.rules : rules);
      const refreshed = await api.getFacebookLeadAutoMessages();
      setActiveNow(refreshed.active_now || saved.active_now);
      setStatus({ type: "success", text: "Auto-message settings saved." });
      setTimeout(() => setStatus(null), 4000);
      void runPreview();
    } catch (err) {
      setStatus({ type: "error", text: err.message });
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    if (!window.confirm("Discard unsaved changes and reload from server?")) return;
    void loadConfig();
  };

  const toggleDay = (ruleIndex, day) => {
    setRules((prev) => prev.map((r, i) => {
      if (i !== ruleIndex) return r;
      const days = new Set(r.days_of_week || []);
      if (days.has(day)) days.delete(day);
      else days.add(day);
      return { ...r, days_of_week: [...days].sort((a, b) => a - b) };
    }));
  };

  const moveRule = (index, direction) => {
    setRules((prev) => {
      const next = [...prev];
      const target = index + direction;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next.map((r, i) => ({ ...r, sort_order: i }));
    });
  };

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

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" /> Loading Facebook Leads settings...
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <h2>Facebook Leads</h2>
        <p>Manage automated SMS replies for new Facebook lead submissions.</p>
      </div>

      {status && (
        <div className={`alert alert-${status.type === "error" ? "error" : "success"}`} style={{ marginBottom: 16 }}>
          {status.text}
        </div>
      )}

      <div className="tabs" style={{ marginBottom: 20, display: "flex", gap: 8 }}>
        {[
          { id: "auto", label: "Auto messages" },
          { id: "pages", label: "Connected pages" },
          { id: "log", label: "Webhook log" },
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            className={`btn ${tab === t.id ? "btn-primary" : "btn-secondary"}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "auto" && settings && (
        <div>
          <div className="card" style={{ marginBottom: 16, padding: 16 }}>
            <h3 style={{ marginTop: 0 }}>Message sending right now</h3>
            {activeNow ? (
              <div>
                <p style={{ margin: "4px 0", color: "#94a3b8" }}>
                  Rule: <strong>{activeNow.ruleLabel || activeNow.rule_label || "—"}</strong>
                </p>
                <pre style={{ whiteSpace: "pre-wrap", background: "#0f172a", padding: 12, borderRadius: 8 }}>
                  {activeNow.rendered || activeNow.template}
                </pre>
              </div>
            ) : (
              <p>No configuration loaded.</p>
            )}
          </div>

          <div className="card" style={{ marginBottom: 16, padding: 16 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
              <input
                type="checkbox"
                checked={settings.is_enabled !== false}
                onChange={(e) => setSettings({ ...settings, is_enabled: e.target.checked })}
              />
              Enable auto-SMS for new leads
            </label>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <label>
                Timezone
                <select
                  className="form-input"
                  value={settings.timezone || "America/Chicago"}
                  onChange={(e) => setSettings({ ...settings, timezone: e.target.value })}
                >
                  {TIMEZONES.map((tz) => (
                    <option key={tz} value={tz}>{tz}</option>
                  ))}
                </select>
              </label>
              <label>
                Rep name
                <input
                  className="form-input"
                  value={settings.rep_name || ""}
                  onChange={(e) => setSettings({ ...settings, rep_name: e.target.value })}
                />
              </label>
              <label>
                Company name
                <input
                  className="form-input"
                  value={settings.company_name || ""}
                  onChange={(e) => setSettings({ ...settings, company_name: e.target.value })}
                />
              </label>
              <label>
                Position label
                <input
                  className="form-input"
                  value={settings.position_label || ""}
                  onChange={(e) => setSettings({ ...settings, position_label: e.target.value })}
                />
              </label>
            </div>

            <p style={{ fontSize: 13, color: "#94a3b8" }}>
              First matching time rule wins (top to bottom). Outside all rules, the fallback message is used.
            </p>
          </div>

          <PlaceholderChips placeholders={placeholders} onInsert={insertPlaceholder} />

          <h3>Time rules</h3>
          {rules.map((rule, index) => (
            <div
              key={index}
              className="card"
              style={{ marginBottom: 12, padding: 16, opacity: rule.is_active === false ? 0.6 : 1 }}
            >
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
                <input
                  className="form-input"
                  style={{ flex: 1, minWidth: 140 }}
                  value={rule.label || ""}
                  onChange={(e) => setRules((prev) => prev.map((r, i) => (
                    i === index ? { ...r, label: e.target.value } : r
                  )))}
                />
                <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <input
                    type="checkbox"
                    checked={rule.is_active !== false}
                    onChange={(e) => setRules((prev) => prev.map((r, i) => (
                      i === index ? { ...r, is_active: e.target.checked } : r
                    )))}
                  />
                  Active
                </label>
                <button type="button" className="btn btn-secondary" onClick={() => moveRule(index, -1)} disabled={index === 0}>↑</button>
                <button type="button" className="btn btn-secondary" onClick={() => moveRule(index, 1)} disabled={index === rules.length - 1}>↓</button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setRules((prev) => prev.filter((_, i) => i !== index))}
                  disabled={rules.length <= 1}
                >
                  Remove
                </button>
              </div>

              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
                {WEEKDAYS.map((d) => (
                  <label key={d.value} style={{ fontSize: 12 }}>
                    <input
                      type="checkbox"
                      checked={(rule.days_of_week || []).includes(d.value)}
                      onChange={() => toggleDay(index, d.value)}
                    />
                    {" "}{d.label}
                  </label>
                ))}
              </div>

              <div style={{ display: "flex", gap: 12, marginBottom: 8 }}>
                <label>
                  Start
                  <input
                    type="time"
                    className="form-input"
                    value={rule.start_time_local || "08:00"}
                    onChange={(e) => setRules((prev) => prev.map((r, i) => (
                      i === index ? { ...r, start_time_local: e.target.value } : r
                    )))}
                  />
                </label>
                <label>
                  End
                  <input
                    type="time"
                    className="form-input"
                    value={rule.end_time_local || "17:00"}
                    onChange={(e) => setRules((prev) => prev.map((r, i) => (
                      i === index ? { ...r, end_time_local: e.target.value } : r
                    )))}
                  />
                </label>
              </div>

              <textarea
                ref={(el) => { ruleRefs.current[index] = el; }}
                className="form-input"
                rows={4}
                placeholder="SMS template for this time window..."
                value={rule.message_template || ""}
                onFocus={() => setFocus("rule", index)}
                onChange={(e) => setRules((prev) => prev.map((r, i) => (
                  i === index ? { ...r, message_template: e.target.value } : r
                )))}
              />
            </div>
          ))}

          <button
            type="button"
            className="btn btn-secondary"
            style={{ marginBottom: 16 }}
            onClick={() => setRules((prev) => [...prev, emptyRule(prev.length)])}
          >
            + Add time rule
          </button>

          <h3>Fallback message (outside hours)</h3>
          <textarea
            ref={fallbackRef}
            className="form-input"
            rows={4}
            value={settings.fallback_template || ""}
            onFocus={() => setFocus("fallback")}
            onChange={(e) => setSettings({ ...settings, fallback_template: e.target.value })}
          />

          <div className="card" style={{ marginTop: 16, padding: 16 }}>
            <h3 style={{ marginTop: 0 }}>Live preview</h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 8 }}>
              <input
                className="form-input"
                placeholder="Full name"
                value={sampleLead.full_name}
                onChange={(e) => setSampleLead({ ...sampleLead, full_name: e.target.value })}
              />
              <input
                className="form-input"
                placeholder="Phone"
                value={sampleLead.phone_number}
                onChange={(e) => setSampleLead({ ...sampleLead, phone_number: e.target.value })}
              />
              <input
                className="form-input"
                placeholder="Email"
                value={sampleLead.email}
                onChange={(e) => setSampleLead({ ...sampleLead, email: e.target.value })}
              />
            </div>
            {previewMeta && !previewMeta.error && (
              <p style={{ fontSize: 13, color: "#94a3b8" }}>
                Would use: <strong>{previewMeta.rule_label}</strong>
                {" · "}{previewMeta.segments?.length || 0} chars
                {(previewMeta.segments?.segments || 0) > 1 ? ` (${previewMeta.segments.segments} SMS segments)` : ""}
                {(previewMeta.segments?.length || 0) > 320 ? " — long message (multipart SMS)" : ""}
              </p>
            )}
            {previewMeta?.error && (
              <p style={{ color: "#ef4444", fontSize: 13 }}>{previewMeta.error}</p>
            )}
            <pre style={{ whiteSpace: "pre-wrap", background: "#0f172a", padding: 12, borderRadius: 8 }}>
              {previewText || "(empty)"}
            </pre>
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            <button type="button" className="btn btn-primary" disabled={saving} onClick={handleSave}>
              {saving ? "Saving..." : "Save settings"}
            </button>
            <button type="button" className="btn btn-secondary" onClick={handleReset}>Reset</button>
          </div>
        </div>
      )}

      {tab === "pages" && (
        <div className="card" style={{ padding: 16 }}>
          <h3 style={{ marginTop: 0 }}>Connected Facebook Pages</h3>
          {pages.length === 0 ? (
            <p>No pages connected. Use /connect in a Telegram leads group.</p>
          ) : (
            <table className="data-table" style={{ width: "100%" }}>
              <thead>
                <tr>
                  <th>Page</th>
                  <th>Telegram group</th>
                  <th>Active</th>
                  <th>Connected</th>
                </tr>
              </thead>
              <tbody>
                {pages.map((p) => (
                  <tr key={p.id}>
                    <td>{p.page_name} <span style={{ color: "#64748b" }}>({p.page_id})</span></td>
                    <td>{p.group_name || p.telegram_group_id}</td>
                    <td>{p.is_active ? "Yes" : "No"}</td>
                    <td>{p.connected_at ? new Date(p.connected_at).toLocaleString() : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === "log" && (
        <div className="card" style={{ padding: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h3 style={{ marginTop: 0 }}>Webhook log</h3>
            <button type="button" className="btn btn-secondary" onClick={loadWebhookLog} disabled={logLoading}>
              Refresh
            </button>
          </div>
          {logLoading ? (
            <p>Loading...</p>
          ) : webhookLog.length === 0 ? (
            <p>No events yet.</p>
          ) : (
            <table className="data-table" style={{ width: "100%", fontSize: 13 }}>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Type</th>
                  <th>Page</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {webhookLog.map((e) => (
                  <tr key={e.id}>
                    <td>{e.id}</td>
                    <td>{e.event_type}</td>
                    <td>{e.page_id}</td>
                    <td>{e.status}</td>
                    <td>{e.created_at ? new Date(e.created_at).toLocaleString() : "—"}</td>
                    <td>
                      <button type="button" className="btn btn-secondary" onClick={() => handleRetry(e.id)}>
                        Retry
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
