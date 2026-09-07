import React, { useCallback, useEffect, useState } from "react";
import * as api from "../../../api";
import BitrixAutomapPanel from "./BitrixAutomapPanel";
import BitrixSettingsForm from "./BitrixSettingsForm";

/**
 * Bitrix24 — the half of the lead-SMS chain that lives outside this app.
 *
 * It sits on the RingCentral tab on purpose: the Bitrix ASSIGNEE is what
 * decides which recruiter's number texts a driver, so the mapping on the rows
 * below is only half the wiring. Bitrix used to be configured entirely by
 * environment variables and visible only in server logs, which meant a portal
 * that never assigns a lead looked exactly like a portal that works — while
 * every lead quietly went out from the shared company number.
 *
 * Three things live here, in the order an operator meets them: the connection
 * form (the webhook and behaviour, entered here rather than on the host — the
 * DB row wins over env once saved), **Diagnose** (read-only), and the mapping
 * panel (previews first; writes `bitrix_user_id` only when applied).
 */
function Row({ label, value, warn = false }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div style={{ display: "flex", gap: 8, fontSize: 13, padding: "3px 0" }}>
      <span style={{ color: "#94a3b8", minWidth: 190 }}>{label}</span>
      <span style={{ color: warn ? "#f87171" : "#cbd5e1", fontFamily: warn ? "inherit" : "ui-monospace, monospace" }}>
        {value}
      </span>
    </div>
  );
}

export default function BitrixCard({ onMessage, onMapped }) {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [diag, setDiag] = useState(null);
  const [diagnosing, setDiagnosing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSettings(await api.getBitrixSettings());
    } catch (err) {
      onMessage?.({ type: "error", text: `Bitrix settings: ${err.message}` });
    } finally {
      setLoading(false);
    }
  }, [onMessage]);
  useEffect(() => { load(); }, [load]);

  const runDiagnose = async () => {
    setDiagnosing(true); setDiag(null);
    try { setDiag(await api.diagnoseBitrix({})); }
    catch (err) { setDiag({ ok: false, steps: [{ label: "Diagnostic", ok: false, detail: err.message }] }); }
    finally { setDiagnosing(false); }
  };

  if (loading) return <div className="card" style={{ marginBottom: 16 }}>Loading Bitrix24…</div>;

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <h3 style={{ margin: 0 }}>🧩 Bitrix24 — who a lead is assigned to</h3>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span className={`badge ${settings?.configured ? "badge-active" : "badge-inactive"}`}>
            {settings?.configured ? "Configured" : "Not configured"}
          </span>
          <button className="btn btn-ghost btn-sm" onClick={runDiagnose} disabled={diagnosing}>
            {diagnosing ? "Diagnosing…" : "Diagnose"}
          </button>
        </div>
      </div>

      <p style={{ fontSize: 13, color: "#94a3b8", marginTop: 8, marginBottom: 8 }}>
        A Facebook lead is texted from the number of whoever Bitrix assigned it to. Bitrix assigns
        <strong> after </strong> the lead is created, so the app re-reads the owner for up to{" "}
        <strong>{Math.round((settings?.assigneeWaitMs ?? 0) / 1000)}s</strong> and matches it to the
        <strong> Bitrix24 user ID</strong> on a recruiter row below. No match means the shared number.
      </p>

      <BitrixSettingsForm settings={settings} onSaved={setSettings} onMessage={onMessage} />

      <Row label="Portal" value={settings?.webhookHost} />
      <Row label="Creates" value={settings?.entity} />
      <Row label="Source ID" value={settings?.sourceId} />
      <Row label="Assignee at creation" value={settings?.assignedById ? `Bitrix user ${settings.assignedById}` : "not set — the webhook owner, then a Bitrix rule"} />
      {settings?.assignedByIdIgnored && (
        <Row
          warn
          label="⚠️ BITRIX24_ASSIGNED_BY_ID"
          value={`"${settings.assignedByIdRaw}" is not a numeric Bitrix user id, so it is ignored`}
        />
      )}
      {settings?.entity === "deal" && (
        <>
          <Row label="Deal category" value={settings?.dealCategoryId} />
          <Row label="Deal stage" value={settings?.dealStageId} />
        </>
      )}

      <BitrixAutomapPanel onMapped={onMapped} />

      {diag && (
        <div style={{ marginTop: 12, padding: 10, borderRadius: 8, background: "rgba(148,163,184,0.08)" }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: diag.ok ? "#22c55e" : "#f87171" }}>
            {diag.ok ? "✓ Bitrix is aligned" : "✕ Needs attention"}
          </div>
          {(diag.steps || []).map((s, idx) => (
            <div key={idx} style={{ fontSize: 12, marginBottom: 5 }}>
              <span style={{ color: s.ok ? "#22c55e" : "#f87171" }}>{s.ok ? "✓" : "✕"}</span>{" "}
              <strong style={{ color: "#cbd5e1" }}>{s.label}:</strong>{" "}
              <span style={{ color: "#94a3b8" }}>{s.detail}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
