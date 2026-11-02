import React, { useCallback, useEffect, useState } from "react";
import * as api from "../../../api";
import BitrixAutomapPanel from "./BitrixAutomapPanel";
import BitrixSettingsForm from "./BitrixSettingsForm";

/**
 * Bitrix24 — the half of the lead-SMS chain that lives outside this app.
 *
 * Settings → Bitrix24 since November 2026 (a card on the RingCentral screen
 * before). The Bitrix ASSIGNEE is what decides which recruiter's number texts
 * a driver, so the mapping on the recruiter rows (Recruiters & Numbers) is
 * only half the wiring. Bitrix used to be configured entirely by
 * environment variables and visible only in server logs, which meant a portal
 * that never assigns a lead looked exactly like a portal that works — while
 * every lead quietly went out from the shared company number.
 *
 * Three things live here, in the order an operator meets them: the connection
 * form (the webhook and behaviour, entered here rather than on the host — the
 * DB row wins over env once saved), **Diagnose** (read-only), and the mapping
 * panel (previews first; writes `bitrix_user_id` only when applied).
 *
 * The read-only list of the saved values that used to sit under the form
 * (portal, creates, source, assignee, deal category and stage) is gone: the
 * form shows every one of them, the ignored-assignee warning included.
 */
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
        <h3 style={{ margin: 0 }}>Bitrix24 — who a lead is assigned to</h3>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span className={`badge ${settings?.configured ? "badge-active" : "badge-inactive"}`}>
            {settings?.configured ? "Configured" : "Not configured"}
          </span>
          <button className="btn btn-ghost btn-sm" onClick={runDiagnose} disabled={diagnosing}>
            {diagnosing ? "Diagnosing…" : "Diagnose"}
          </button>
        </div>
      </div>

      <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 8, marginBottom: 8 }}>
        A Facebook lead is texted from the number of whoever Bitrix assigned it to. Bitrix assigns
        <strong> after </strong> the lead is created, so the app re-reads the owner for up to{" "}
        <strong>{Math.round((settings?.assigneeWaitMs ?? 0) / 1000)}s</strong> and matches it to the
        <strong> Bitrix24 user ID</strong> on the recruiter's row. No match means the shared number.
      </p>

      <BitrixSettingsForm settings={settings} onSaved={setSettings} onMessage={onMessage} />

      <BitrixAutomapPanel onMapped={onMapped} />

      {diag && (
        <div style={{ marginTop: 12, padding: 10, borderRadius: 8, background: "var(--neutral-soft)" }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: diag.ok ? "var(--success)" : "var(--danger)" }}>
            {diag.ok ? "✓ Bitrix is aligned" : "✕ Needs attention"}
          </div>
          {(diag.steps || []).map((s, idx) => (
            <div key={idx} style={{ fontSize: 12, marginBottom: 5 }}>
              <span style={{ color: s.ok ? "var(--success)" : "var(--danger)" }}>{s.ok ? "✓" : "✕"}</span>{" "}
              <strong style={{ color: "var(--text-secondary)" }}>{s.label}:</strong>{" "}
              <span style={{ color: "var(--text-muted)" }}>{s.detail}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
