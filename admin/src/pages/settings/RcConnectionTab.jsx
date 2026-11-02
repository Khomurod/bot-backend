import React, { useEffect, useState } from "react";
import * as api from "../../api";
import { KeyField, NumField, Banner } from "./fields";
import PageFailure from "../../components/PageFailure";
import useRingCentralSettings from "./ringcentral/useRingCentralSettings";

/**
 * Settings → RingCentral Connection (`#settings/rc_connection`): the shared app
 * credentials every recruiter number signs in with, the monitoring switch, and
 * how often the call log is read.
 *
 * One of three sections the "RingCentral & Bitrix24" screen became in November
 * 2026 (six cards on three subjects). The recruiters are under Recruiters &
 * Numbers, the Bitrix24 connection under Bitrix24, and the KPI targets on
 * Recruiter KPIs → Targets. Save sends only the fields on this screen.
 */
export default function RcConnectionTab() {
  const { settings, loading, loadError, load, save } = useRingCentralSettings();
  const [form, setForm] = useState({ clientId: "", clientSecret: "", jwtToken: "", apiBase: "", enabled: false, pollMinutes: 10 });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [test, setTest] = useState(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (!settings) return;
    setForm((f) => ({ ...f, apiBase: settings.apiBase || "", enabled: settings.enabled, pollMinutes: settings.pollMinutes }));
  }, [settings]);

  const setField = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const onSave = async () => {
    setSaving(true); setMessage(null);
    try {
      const payload = { enabled: form.enabled, apiBase: form.apiBase, pollMinutes: Number(form.pollMinutes) };
      if (form.clientId.trim()) payload.clientId = form.clientId.trim();
      if (form.clientSecret.trim()) payload.clientSecret = form.clientSecret.trim();
      if (form.jwtToken.trim()) payload.jwtToken = form.jwtToken.trim();
      await save(payload);
      setForm((f) => ({ ...f, clientId: "", clientSecret: "", jwtToken: "" }));
      setMessage({ type: "success", text: "RingCentral connection saved." });
    } catch (err) { setMessage({ type: "error", text: err.message }); }
    finally { setSaving(false); }
  };

  const runTest = async () => {
    setTesting(true); setTest(null);
    try {
      const res = await api.testRingCentral({
        clientId: form.clientId.trim() || undefined,
        clientSecret: form.clientSecret.trim() || undefined,
        jwtToken: form.jwtToken.trim() || undefined,
        apiBase: form.apiBase.trim() || undefined,
      });
      setTest(res);
    } catch (err) { setTest({ connected: false, message: err.message }); }
    finally { setTesting(false); }
  };

  if (loading) return <div className="loading"><div className="spinner"></div> Loading…</div>;
  if (!settings) return <PageFailure error={loadError} where="RingCentral settings" onRetry={load} />;

  return (
    <div>
      <p style={{ color: "var(--text-muted)", marginTop: 0 }}>
        RingCentral powers recruiter call KPIs and <strong>who texts a lead</strong>. The recruiters
        and their numbers are under <a href="#settings/ringcentral">Recruiters &amp; Numbers</a>;
        the daily targets are on <a href="#recruiter_kpis/targets">Recruiter KPIs → Targets</a>.
      </p>
      <Banner message={message} />

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
          <h3 style={{ margin: 0 }}>RingCentral Credentials</h3>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14 }}>
            <input type="checkbox" checked={form.enabled} onChange={(e) => setField("enabled", e.target.checked)} /> Monitoring enabled
          </label>
        </div>
        <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 0 }}>
          The <strong>shared Client ID/Secret</strong> are used by every number that doesn't have
          its own custom pair. Each number's own JWT token is entered on its recruiter row.
          The shared JWT is optional — it's only used as a company-log fallback for numbers
          without their own JWT (that path needs an admin-role user with <strong>Read Call Log</strong>).
        </p>
        <KeyField label="Shared Client ID" hint={settings.clientIdSet ? settings.clientIdMasked : "not set"} fromEnv={settings.fromEnv?.clientId} value={form.clientId} onChange={(v) => setField("clientId", v)} />
        <KeyField label="Shared Client Secret" hint={settings.clientSecretSet ? settings.clientSecretMasked : "not set"} fromEnv={settings.fromEnv?.clientSecret} value={form.clientSecret} onChange={(v) => setField("clientSecret", v)} />
        <KeyField label="Shared JWT Token (optional fallback)" hint={settings.jwtTokenSet ? settings.jwtTokenMasked : "not set"} fromEnv={settings.fromEnv?.jwtToken} value={form.jwtToken} onChange={(v) => setField("jwtToken", v)} />
        <div className="form-group">
          <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>API Base URL</label>
          <input className="form-input" value={form.apiBase} placeholder="https://platform.ringcentral.com" onChange={(e) => setField("apiBase", e.target.value)} />
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>Use <code>https://platform.ringcentral.com</code> for production, <code>https://platform.devtest.ringcentral.com</code> for sandbox.</div>
        </div>
        <NumField label="Read the call log every" value={form.pollMinutes} onChange={(v) => setField("pollMinutes", v)} suffix="minutes" />
        <button className="btn btn-ghost btn-sm" onClick={runTest} disabled={testing}>{testing ? "Testing…" : "Test connection"}</button>
        {test && <span className={`badge ${test.connected ? "badge-active" : "badge-inactive"}`} style={{ marginLeft: 8 }}>{test.connected ? "✓ Connected" : "✕ Not connected"}</span>}
        {test?.message && <div style={{ fontSize: 12, color: test.connected ? "var(--success)" : "var(--danger)", marginTop: 4 }}>{test.message}</div>}
        {settings.lastSyncedAt && <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>Last sync: {new Date(settings.lastSyncedAt).toLocaleString()}{settings.lastSyncError ? ` · ⚠️ ${settings.lastSyncError}` : ""}</div>}
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 24 }}>
        <button className="btn btn-primary" onClick={onSave} disabled={saving}>{saving ? "Saving…" : "Save connection"}</button>
        {settings.updatedAt && <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Last updated {new Date(settings.updatedAt).toLocaleString()}</span>}
      </div>
    </div>
  );
}
