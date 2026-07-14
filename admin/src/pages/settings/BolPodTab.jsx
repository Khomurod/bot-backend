import React, { useCallback, useEffect, useState } from "react";
import * as api from "../../api";
import { Banner } from "./fields";

// ───────────────────────────── BOL / POD tab ────────────────────────────────
// Admin-controlled forwarding of DataTruck BOL/POD documents to Telegram groups.
// OFF by default. Group ids are not secrets; the bot token is never shown.

const DELIVERY_MODES = [
  { value: "driver_group", label: "Driver group only" },
  { value: "central_group", label: "Central group only" },
  { value: "both", label: "Driver + central" },
];
const DOCUMENT_TYPES = [
  { value: "both", label: "Both (BOL + POD)" },
  { value: "bol", label: "BOL only" },
  { value: "pod", label: "POD only" },
];
const UNCERTAIN_POLICIES = [
  { value: "do_not_send", label: "Do not send" },
  { value: "central_review", label: "Send only to the central review group" },
];

const MUTED = "#94a3b8";
const GREEN = "#22c55e";
const RED = "#f87171";
const AMBER = "#f59e0b";

function fmtDate(v) {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

// Map a per-destination status to a badge class + label.
function destBadge(status) {
  if (!status) return { cls: "badge-muted", label: "—" };
  if (status === "sent") return { cls: "badge-active", label: "✓ sent" };
  if (status === "failed") return { cls: "badge-inactive", label: "✕ failed" };
  if (status === "pending" || status === "processing") return { cls: "badge-muted", label: status };
  if (status === "skipped_no_group") return { cls: "badge-inactive", label: "needs review" };
  if (status === "skipped_not_applicable") return { cls: "badge-muted", label: "n/a" };
  if (status === "skipped_same_group") return { cls: "badge-muted", label: "same group" };
  return { cls: "badge-muted", label: status.replace(/^skipped_/, "") };
}

function Segmented({ options, value, onChange }) {
  return (
    <div role="group" style={{ display: "inline-flex", flexWrap: "wrap", gap: 6 }}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`btn btn-sm ${value === o.value ? "btn-primary" : "btn-ghost"} touch-target`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export default function BolPodTab() {
  const [settings, setSettings] = useState(null);
  const [status, setStatus] = useState(null);
  const [deliveries, setDeliveries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [validate, setValidate] = useState(null);
  const [validating, setValidating] = useState(false);
  const [testMsg, setTestMsg] = useState(null);
  const [sendingTest, setSendingTest] = useState(false);
  const [retryingId, setRetryingId] = useState(null);
  const [form, setForm] = useState({
    enabled: false,
    deliveryMode: "driver_group",
    centralGroupId: "",
    documentTypeMode: "both",
    uncertainDocumentPolicy: "do_not_send",
  });

  const seedForm = (s) => setForm({
    enabled: s.enabled,
    deliveryMode: s.deliveryMode,
    centralGroupId: s.centralGroupId || "",
    documentTypeMode: s.documentTypeMode,
    uncertainDocumentPolicy: s.uncertainDocumentPolicy,
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, st, dl] = await Promise.all([
        api.getBolPodSettings(),
        api.getBolPodStatus().catch(() => null),
        api.getBolPodDeliveries(30).catch(() => []),
      ]);
      setSettings(s);
      seedForm(s);
      setStatus(st);
      setDeliveries(dl || []);
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const refreshStatus = async () => {
    try {
      const [st, dl] = await Promise.all([api.getBolPodStatus(), api.getBolPodDeliveries(30)]);
      setStatus(st);
      setDeliveries(dl || []);
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    }
  };

  const setField = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const needsCentral = form.deliveryMode === "central_group" || form.deliveryMode === "both";

  const save = async () => {
    setSaving(true); setMessage(null);
    try {
      const payload = {
        enabled: form.enabled,
        deliveryMode: form.deliveryMode,
        documentTypeMode: form.documentTypeMode,
        uncertainDocumentPolicy: form.uncertainDocumentPolicy,
      };
      // Only send a non-empty central id — an empty field never clears a stored
      // (validated) group. A changed id is re-validated server-side.
      if (String(form.centralGroupId || "").trim()) {
        payload.centralGroupId = String(form.centralGroupId).trim();
      }
      const s = await api.updateBolPodSettings(payload);
      setSettings(s);
      seedForm(s);
      setMessage({ type: "success", text: "BOL/POD settings saved." });
      refreshStatus();
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setSaving(false);
    }
  };

  const runValidate = async () => {
    setValidating(true); setValidate(null);
    try {
      const result = await api.validateBolPodGroup(String(form.centralGroupId || "").trim());
      setValidate(result);
      if (result.ok) {
        // Persisted server-side — reload to reflect validated title/date + badges.
        const s = await api.getBolPodSettings();
        setSettings(s);
      }
    } catch (err) {
      setValidate({ ok: false, message: err.message });
    } finally {
      setValidating(false);
    }
  };

  const runTest = async () => {
    setSendingTest(true); setTestMsg(null);
    try {
      const result = await api.sendBolPodTestMessage(String(form.centralGroupId || "").trim());
      setTestMsg(result);
      if (result.ok) {
        const s = await api.getBolPodSettings();
        setSettings(s);
      }
    } catch (err) {
      setTestMsg({ ok: false, message: err.message });
    } finally {
      setSendingTest(false);
    }
  };

  const retry = async (id) => {
    setRetryingId(id);
    try {
      await api.retryBolPodDelivery(id);
      await refreshStatus();
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setRetryingId(null);
    }
  };

  if (loading) return <div className="loading"><div className="spinner"></div> Loading…</div>;

  const destinationPreview = () => {
    if (form.deliveryMode === "driver_group") return "Each document goes to the matched driver's Telegram group only.";
    if (form.deliveryMode === "central_group") return "Every document goes only to the configured central group.";
    return "Each document goes to the driver's group and to the central group (tracked separately).";
  };

  return (
    <div>
      <p style={{ color: MUTED, marginTop: 0 }}>
        Forward Bill of Lading (BOL) and Proof of Delivery (POD) documents from DataTruck to Telegram groups.
        Documents are matched to a driver's group by name and classified from DataTruck's own document type.
        The feature stays <strong>off</strong> until you enable it below — nothing is sent to any group while it is off.
      </p>
      <Banner message={message} />

      {/* Master switch + routing */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>📄 BOL / POD forwarding</h3>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14 }}>
            <input type="checkbox" checked={form.enabled} onChange={(e) => setField("enabled", e.target.checked)} />
            Enable BOL/POD forwarding
          </label>
        </div>

        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 13, color: MUTED, marginBottom: 6 }}>Delivery destination</div>
          <Segmented options={DELIVERY_MODES} value={form.deliveryMode} onChange={(v) => setField("deliveryMode", v)} />
          <div style={{ fontSize: 12, color: MUTED, marginTop: 6 }}>{destinationPreview()}</div>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 24 }}>
          <div>
            <div style={{ fontSize: 13, color: MUTED, marginBottom: 4 }}>Document types</div>
            <select className="form-input" value={form.documentTypeMode} onChange={(e) => setField("documentTypeMode", e.target.value)}>
              {DOCUMENT_TYPES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <div style={{ fontSize: 13, color: MUTED, marginBottom: 4 }}>When a document's type is unclear</div>
            <select className="form-input" value={form.uncertainDocumentPolicy} onChange={(e) => setField("uncertainDocumentPolicy", e.target.value)}>
              {UNCERTAIN_POLICIES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>Unclear documents are never sent to a driver group.</div>
          </div>
        </div>
      </div>

      {/* Central group (only when routing uses it) */}
      {needsCentral && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginTop: 0 }}>🏢 Central Telegram group</h3>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
            <div style={{ flex: "1 1 260px" }}>
              <div style={{ fontSize: 13, color: MUTED, marginBottom: 4 }}>Central group id</div>
              <input
                className="form-input"
                style={{ fontFamily: "monospace", width: "100%" }}
                placeholder="-1002997837889"
                value={form.centralGroupId}
                onChange={(e) => setField("centralGroupId", e.target.value)}
              />
            </div>
            <button className="btn btn-ghost btn-sm" onClick={runValidate} disabled={validating || !String(form.centralGroupId || "").trim()}>
              {validating ? "Validating…" : "Validate group"}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={runTest} disabled={sendingTest || !String(form.centralGroupId || "").trim()}>
              {sendingTest ? "Sending…" : "Send test message"}
            </button>
          </div>

          <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
            <span className={`badge ${settings.centralGroupValidated ? "badge-active" : "badge-inactive"}`}>
              {settings.centralGroupValidated ? "✓ validated" : "not validated"}
            </span>
            {settings.centralGroupTitle && <span style={{ fontSize: 13 }}>Group: <strong>{settings.centralGroupTitle}</strong></span>}
            <span style={{ fontSize: 12, color: MUTED }}>Last validated {fmtDate(settings.centralGroupValidatedAt)}</span>
            <span style={{ fontSize: 12, color: MUTED }}>Last test {fmtDate(settings.lastTestedAt)}</span>
          </div>
          {validate && (
            <div style={{ fontSize: 12, color: validate.ok ? GREEN : RED, marginTop: 6 }}>{validate.message}</div>
          )}
          {testMsg && (
            <div style={{ fontSize: 12, color: testMsg.ok ? GREEN : RED, marginTop: 4 }}>{testMsg.message}</div>
          )}
          <div style={{ fontSize: 12, color: MUTED, marginTop: 6 }}>
            You must validate the central group before enabling a central-routing mode.
          </div>
        </div>
      )}

      {/* Save */}
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 20 }}>
        <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save settings"}</button>
        {settings.updatedAt && <span style={{ fontSize: 12, color: MUTED }}>Last updated {fmtDate(settings.updatedAt)}{settings.updatedBy ? ` by ${settings.updatedBy}` : ""}</span>}
      </div>

      {/* Status panel */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>📊 Status</h3>
          <button className="btn btn-ghost btn-sm" onClick={refreshStatus}>↻ Refresh</button>
        </div>
        {status ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10, fontSize: 13 }}>
            <div>Feature: <span className={`badge ${status.enabled ? "badge-active" : "badge-inactive"}`}>{status.enabled ? "enabled" : "disabled"}</span></div>
            <div>Routing mode: <strong>{status.deliveryMode}</strong></div>
            <div>Document source: <span className={`badge ${status.sourceConfigured ? "badge-active" : "badge-inactive"}`}>{status.sourceConfigured ? "connected" : "not configured"}</span></div>
            <div>Central group: {status.centralGroupConfigured ? <strong>{status.centralGroupTitle || status.centralGroupId}</strong> : <span style={{ color: MUTED }}>none</span>}</div>
            <div>Last successful forward: {fmtDate(status.lastSuccessAt)}</div>
            <div>Last failure: {fmtDate(status.lastFailureAt)}</div>
            <div>Pending retries: <strong>{status.pendingRetries}</strong></div>
            <div>Last document check: {fmtDate(status.lastCheckedAt)}</div>
            {status.lastError && <div style={{ gridColumn: "1 / -1", color: AMBER }}>Last error: {status.lastError}</div>}
          </div>
        ) : <div style={{ color: MUTED, fontSize: 13 }}>Status unavailable.</div>}
      </div>

      {/* Recent deliveries */}
      <div className="card">
        <h3 style={{ marginTop: 0 }}>🧾 Recent deliveries</h3>
        {deliveries.length === 0 ? (
          <div style={{ color: MUTED, fontSize: 13 }}>No deliveries recorded yet.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left", color: MUTED }}>
                  <th style={{ padding: "6px 8px" }}>Type</th>
                  <th style={{ padding: "6px 8px" }}>Load</th>
                  <th style={{ padding: "6px 8px" }}>Driver</th>
                  <th style={{ padding: "6px 8px" }}>Driver group</th>
                  <th style={{ padding: "6px 8px" }}>Central group</th>
                  <th style={{ padding: "6px 8px" }}>Updated</th>
                  <th style={{ padding: "6px 8px" }}></th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((d) => {
                  const dBadge = destBadge(d.driver.status);
                  const cBadge = destBadge(d.central.status);
                  const canRetry = d.driver.status === "failed" || d.central.status === "failed";
                  return (
                    <tr key={d.id} style={{ borderTop: "1px solid rgba(148,163,184,0.15)" }}>
                      <td style={{ padding: "6px 8px", textTransform: "uppercase" }}>{d.docType || d.fileType}</td>
                      <td style={{ padding: "6px 8px" }}>{d.loadReference || "—"}</td>
                      <td style={{ padding: "6px 8px" }}>{d.driverName || "—"}</td>
                      <td style={{ padding: "6px 8px" }}>
                        <span className={`badge ${dBadge.cls}`}>{dBadge.label}</span>
                        {d.driver.error && <div style={{ fontSize: 11, color: RED }}>{d.driver.error}</div>}
                      </td>
                      <td style={{ padding: "6px 8px" }}>
                        <span className={`badge ${cBadge.cls}`}>{cBadge.label}</span>
                        {d.central.error && <div style={{ fontSize: 11, color: RED }}>{d.central.error}</div>}
                      </td>
                      <td style={{ padding: "6px 8px", color: MUTED }}>{fmtDate(d.updatedAt)}</td>
                      <td style={{ padding: "6px 8px" }}>
                        {canRetry && (
                          <button className="btn btn-ghost btn-sm" onClick={() => retry(d.id)} disabled={retryingId === d.id}>
                            {retryingId === d.id ? "…" : "Retry"}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
