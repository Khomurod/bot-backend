import React, { useState, useEffect, useCallback, useRef } from "react";
import * as api from "../api";
import { timeAgo, friendlyTimezone } from "../utils/formatTime";

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

function mapPreviewResult(result) {
  if (!result) return null;
  return {
    rendered: result.rendered || "",
    rule_label: result.rule_label || "",
    source: result.source || "",
    segments: result.segments || null,
    timezone: result.timezone || "",
    timezone_friendly: result.timezone_friendly || "",
    evaluated_at_iso: result.evaluated_at_iso || null,
  };
}

function statusPillClass(status) {
  switch ((status || "").toLowerCase()) {
    case "processed": return "status-pill status-pill--success";
    case "failed": return "status-pill status-pill--danger";
    case "pending": return "status-pill status-pill--warning";
    default: return "status-pill status-pill--neutral";
  }
}

function shortenId(id) {
  if (id == null) return "—";
  const s = String(id);
  return s.length > 8 ? `#${s.slice(-6)}` : `#${s}`;
}

function PreviewPanel({ title, subtitle, preview, emptyText = "(empty)" }) {
  const charCount = preview?.segments?.length ?? 0;
  const segmentCount = preview?.segments?.segments ?? 1;

  return (
    <div className="card" style={{ padding: 16, flex: 1, minWidth: 280 }}>
      <h3 style={{ marginTop: 0, marginBottom: 4 }}>{title}</h3>
      {subtitle && (
        <p style={{ margin: "0 0 12px", fontSize: 13, color: "#94a3b8" }}>{subtitle}</p>
      )}
      {preview?.error ? (
        <p style={{ color: "#ef4444", fontSize: 13 }}>{preview.error}</p>
      ) : preview ? (
        <>
          <p style={{ margin: "4px 0", fontSize: 13, color: "#94a3b8" }}>
            Would use: <strong>{preview.rule_label || "—"}</strong>
            {charCount > 0 && (
              <>
                {" · "}{charCount} chars
                {segmentCount > 1 ? ` (${segmentCount} SMS segments)` : ""}
                {charCount > 320 ? " — long message (multipart SMS)" : ""}
              </>
            )}
          </p>
          <pre style={{ whiteSpace: "pre-wrap", background: "#0f172a", padding: 12, borderRadius: 8, margin: 0 }}>
            {preview.rendered || emptyText}
          </pre>
        </>
      ) : (
        <p style={{ color: "#94a3b8", fontSize: 13 }}>Loading preview…</p>
      )}
    </div>
  );
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
  const isDev = new URLSearchParams(window.location.search).get('dev') === '1';
  const [tab, setTab] = useState("auto");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null);

  const [settings, setSettings] = useState(null);
  const [rules, setRules] = useState([]);
  const [placeholders, setPlaceholders] = useState([]);

  const [previewTarget, setPreviewTarget] = useState({ kind: "rule", index: 0 });
  const [nowPreview, setNowPreview] = useState(null);
  const [editPreview, setEditPreview] = useState(null);

  const [sampleLead, setSampleLead] = useState({
    full_name: "Jane Doe",
    phone_number: "+15551234567",
    email: "jane@example.com",
  });

  const [pages, setPages] = useState([]);
  const [webhookLog, setWebhookLog] = useState([]);
  const [logLoading, setLogLoading] = useState(false);

  const [showResetConfirm, setShowResetConfirm] = useState(false);

  const focusRef = useRef({ type: "rule", index: 0 });
  const fallbackRef = useRef(null);
  const ruleRefs = useRef({});

  const timezone = settings?.timezone || "America/Chicago";

  const focusRule = (index) => {
    focusRef.current = { type: "rule", index };
    setPreviewTarget({ kind: "rule", index });
  };

  const focusFallback = () => {
    focusRef.current = { type: "fallback", index: null };
    setPreviewTarget({ kind: "fallback" });
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
      const loadedRules = data.rules?.length ? data.rules : [emptyRule(0)];
      setSettings(data.settings || {
        timezone: "America/Chicago",
        is_enabled: true,
        rep_name: "Tom",
        company_name: "Wenze trucking company",
        position_label: "OTR position",
        fallback_template: "",
      });
      setRules(loadedRules);
      setPlaceholders(data.placeholders || []);
      setPreviewTarget(loadedRules.length ? { kind: "rule", index: 0 } : { kind: "fallback" });
      focusRef.current = loadedRules.length
        ? { type: "rule", index: 0 }
        : { type: "fallback", index: null };
    } catch (err) {
      setStatus({ type: "error", text: err.message });
    } finally {
      setLoading(false);
    }
  }, []);

  const runNowPreview = useCallback(async () => {
    if (!settings) return;
    try {
      const result = await api.previewFacebookLeadAutoMessage({
        settings,
        rules,
        field_map: sampleLead,
      });
      setNowPreview(mapPreviewResult(result));
    } catch (err) {
      setNowPreview({ error: err.message });
    }
  }, [settings, rules, sampleLead]);

  const runEditPreview = useCallback(async () => {
    if (!settings) return;

    let template = "";
    let ruleLabel = "Preview";

    if (previewTarget.kind === "fallback") {
      template = settings.fallback_template || "";
      ruleLabel = "Fallback (outside hours)";
    } else {
      const rule = rules[previewTarget.index];
      if (!rule) return;
      template = rule.message_template || "";
      ruleLabel = rule.label || `Rule ${previewTarget.index + 1}`;
    }

    try {
      const result = await api.previewFacebookLeadAutoMessage({
        settings,
        rules,
        field_map: sampleLead,
        template,
        rule_label: ruleLabel,
      });
      setEditPreview(mapPreviewResult(result));
    } catch (err) {
      setEditPreview({ error: err.message });
    }
  }, [settings, rules, sampleLead, previewTarget]);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    const t = setTimeout(() => { void runNowPreview(); }, 400);
    return () => clearTimeout(t);
  }, [runNowPreview]);

  useEffect(() => {
    const t = setTimeout(() => { void runEditPreview(); }, 400);
    return () => clearTimeout(t);
  }, [runEditPreview]);

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
      setStatus({ type: "success", text: "Auto-message settings saved." });
      setTimeout(() => setStatus(null), 4000);
    } catch (err) {
      setStatus({ type: "error", text: err.message });
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setShowResetConfirm(true);
  };

  const confirmReset = () => {
    setShowResetConfirm(false);
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
    if (previewTarget.kind === "rule" && previewTarget.index === index) {
      const newIndex = index + direction;
      focusRule(newIndex);
    } else if (previewTarget.kind === "rule" && previewTarget.index === index + direction) {
      focusRule(index);
    }
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

  const activePages = pages.filter((p) => p.is_active);
  const recentEvents = webhookLog.filter((e) => {
    if (!e.created_at) return false;
    const diff = Date.now() - new Date(e.created_at).getTime();
    return diff < 7 * 24 * 60 * 60 * 1000;
  });

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

      {tab === "auto" && settings && (
        <div>
          <PreviewPanel
            title="📱 Live Preview — What New Leads Receive Now"
            subtitle={nowSubtitle}
            preview={nowPreview}
          />

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
                  value={timezone}
                  onChange={(e) => setSettings({ ...settings, timezone: e.target.value })}
                >
                  {TIMEZONES.map((tz) => (
                    <option key={tz} value={tz}>{friendlyTimezone(tz)} ({tz})</option>
                  ))}
                </select>
                <span style={{ display: "block", fontSize: 12, color: "#94a3b8", marginTop: 4 }}>
                  All rule start/end times use this timezone.
                </span>
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
              style={{
                marginBottom: 12,
                padding: 16,
                opacity: rule.is_active === false ? 0.6 : 1,
                outline: previewTarget.kind === "rule" && previewTarget.index === index
                  ? "1px solid #6366f1"
                  : undefined,
              }}
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
                  onClick={() => {
                    setRules((prev) => prev.filter((_, i) => i !== index));
                    if (previewTarget.kind === "rule" && previewTarget.index >= index) {
                      focusRule(Math.max(0, previewTarget.index - 1));
                    }
                  }}
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

              <div style={{ display: "flex", gap: 12, marginBottom: 4, alignItems: "flex-end" }}>
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
              <p style={{ fontSize: 11, color: "#64748b", margin: "0 0 8px" }}>
                Times in {friendlyTimezone(timezone)} ({timezone})
              </p>

              <textarea
                ref={(el) => { ruleRefs.current[index] = el; }}
                className="form-input"
                rows={4}
                placeholder="SMS template for this time window..."
                value={rule.message_template || ""}
                onFocus={() => focusRule(index)}
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
            onClick={() => {
              const nextIndex = rules.length;
              setRules((prev) => [...prev, emptyRule(prev.length)]);
              focusRule(nextIndex);
            }}
          >
            + Add time rule
          </button>

          <h3>Fallback message (outside hours)</h3>
          <textarea
            ref={fallbackRef}
            className="form-input"
            rows={4}
            style={{
              outline: previewTarget.kind === "fallback" ? "1px solid #6366f1" : undefined,
            }}
            value={settings.fallback_template || ""}
            onFocus={focusFallback}
            onChange={(e) => setSettings({ ...settings, fallback_template: e.target.value })}
          />

          <div className="card" style={{ marginTop: 16, padding: 16 }}>
            <details className="collapse-panel">
              <summary>Customize test lead data</summary>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginTop: 12, marginBottom: 16 }}>
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
            </details>

            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 12 }}>
              <PreviewPanel
                title="✏️ Editing Preview"
                subtitle={`Previewing: ${editingLabel}. Click a rule or fallback above to switch.`}
                preview={editPreview}
              />
            </div>
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
                    <td>{p.page_name || p.page_id}</td>
                    <td>{p.group_name || p.telegram_group_id}</td>
                    <td>
                      {p.is_active
                        ? <span className="status-pill status-pill--success">Yes</span>
                        : <span className="status-pill status-pill--danger">No</span>
                      }
                    </td>
                    <td>{timeAgo(p.connected_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {isDev && tab === "log" && (
        <div className="card" style={{ padding: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h3 style={{ marginTop: 0 }}>Activity Log</h3>
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
                  <th>Event</th>
                  <th>Page</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {webhookLog.map((e) => (
                  <tr key={e.id}>
                    <td>{shortenId(e.id)}</td>
                    <td>{e.event_type}</td>
                    <td>{e.page_name || e.page_id}</td>
                    <td><span className={statusPillClass(e.status)}>{e.status}</span></td>
                    <td>{timeAgo(e.created_at)}</td>
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

      {/* ─── Confirm Reset Dialog ─── */}
      {showResetConfirm && (
        <div className="confirm-overlay" onClick={() => setShowResetConfirm(false)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Discard unsaved changes?</h3>
            <p>This will reload all settings from the server. Any edits you haven't saved will be lost.</p>
            <div className="confirm-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setShowResetConfirm(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-danger" onClick={confirmReset}>
                Discard changes
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
