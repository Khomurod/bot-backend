import React, { useCallback, useEffect, useState } from "react";
import * as api from "../../api";
import { KeyField, Banner } from "./fields";

// ─────────────────────────────── Live Location tab ───────────────────────────

export default function LocationProvidersTab() {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [testResults, setTestResults] = useState({});
  const [testing, setTesting] = useState({});
  const [testUnit, setTestUnit] = useState("");
  const [form, setForm] = useState({
    samsaraApiKey: "", driveHosProviderKey: "", driveHosApiBase: "",
    factorCompanyKey: "", leaderCompanyKey: "",
    samsaraEnabled: true, factorEnabled: true, leaderEnabled: true,
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const s = await api.getEldSettings();
      setSettings(s);
      setForm((f) => ({ ...f, driveHosApiBase: s.driveHosApiBase || "", samsaraEnabled: s.samsaraEnabled, factorEnabled: s.factorEnabled, leaderEnabled: s.leaderEnabled }));
    } catch (err) { setMessage({ type: "error", text: err.message }); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const setField = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setSaving(true); setMessage(null);
    try {
      const payload = {
        samsaraEnabled: form.samsaraEnabled, factorEnabled: form.factorEnabled,
        leaderEnabled: form.leaderEnabled, driveHosApiBase: form.driveHosApiBase,
      };
      if (form.samsaraApiKey.trim()) payload.samsaraApiKey = form.samsaraApiKey.trim();
      if (form.driveHosProviderKey.trim()) payload.driveHosProviderKey = form.driveHosProviderKey.trim();
      if (form.factorCompanyKey.trim()) payload.factorCompanyKey = form.factorCompanyKey.trim();
      if (form.leaderCompanyKey.trim()) payload.leaderCompanyKey = form.leaderCompanyKey.trim();
      const s = await api.updateEldSettings(payload);
      setSettings(s);
      setForm((f) => ({ ...f, samsaraApiKey: "", driveHosProviderKey: "", factorCompanyKey: "", leaderCompanyKey: "" }));
      setMessage({ type: "success", text: "Live-location settings saved." });
    } catch (err) { setMessage({ type: "error", text: err.message }); }
    finally { setSaving(false); }
  };

  // A base URL that points at Swagger/interactive docs instead of the real API
  // host — mirrors the backend check so we can warn before a doomed test call.
  const baseUrlLooksLikeDocs = (url) => {
    const s = String(url || "").toLowerCase();
    if (!s) return false;
    return s.includes("/swagger") || s.includes("/index.html") || s.includes("#")
      || s.includes("/api-docs") || s.includes("/redoc");
  };
  const effectiveApiBase = (form.driveHosApiBase || settings?.driveHosApiBase || "").trim();
  const apiBaseIsDocs = baseUrlLooksLikeDocs(effectiveApiBase);

  const runTest = async (provider, candidate = {}) => {
    // Client-side field validation for Drive HoS providers with clear messages.
    if (provider === "factor" || provider === "leader") {
      const label = provider === "factor" ? "Factor ELD" : "Leader ELD";
      const providerKeySet = form.driveHosProviderKey.trim() || settings?.driveHosProviderKeySet;
      const companyKeySet = provider === "factor"
        ? (form.factorCompanyKey.trim() || settings?.factorCompanyKeySet)
        : (form.leaderCompanyKey.trim() || settings?.leaderCompanyKeySet);
      if (!providerKeySet) {
        setTestResults((r) => ({ ...r, [provider]: { connected: false, message: `Provider Key is required before testing ${label}.` } }));
        return;
      }
      if (!effectiveApiBase) {
        setTestResults((r) => ({ ...r, [provider]: { connected: false, message: `API Base URL is required before testing ${label}.` } }));
        return;
      }
      if (apiBaseIsDocs) {
        setTestResults((r) => ({ ...r, [provider]: { connected: false, message: "This looks like a documentation URL, not the actual API base URL." } }));
        return;
      }
      if (!companyKeySet) {
        const ck = provider === "factor" ? "Factor Company Key" : "Leader Company Key";
        setTestResults((r) => ({ ...r, [provider]: { connected: false, message: `${ck} is required before testing ${label}.` } }));
        return;
      }
    }
    setTesting((t) => ({ ...t, [provider]: true }));
    setTestResults((r) => ({ ...r, [provider]: null }));
    try {
      const groupTitle = testUnit.trim() ? `UNIT # ${testUnit.trim()}` : "";
      // Pass the (possibly edited) API base so the operator can verify a corrected
      // URL before saving it.
      const apiBase = effectiveApiBase || undefined;
      const result = await api.testEldProvider({ provider, groupTitle, apiBase, ...candidate });
      setTestResults((r) => ({ ...r, [provider]: result }));
    } catch (err) {
      setTestResults((r) => ({ ...r, [provider]: { connected: false, message: err.message } }));
    } finally { setTesting((t) => ({ ...t, [provider]: false })); }
  };

  if (loading) return <div className="loading"><div className="spinner"></div> Loading…</div>;

  const TestBadge = ({ provider }) => {
    const r = testResults[provider];
    if (testing[provider]) return <span className="badge badge-muted">Testing…</span>;
    if (!r) return null;
    return <span className={`badge ${r.connected ? "badge-active" : "badge-inactive"}`} style={{ marginLeft: 8 }} title={r.message}>{r.connected ? "✓ Connected" : "✕ Not connected"}</span>;
  };
  const TestMessage = ({ provider }) => {
    const r = testResults[provider];
    if (!r || !r.message) return null;
    return <div style={{ fontSize: 12, color: r.connected ? "#22c55e" : "#f87171", marginTop: 4 }}>{r.message}</div>;
  };

  return (
    <div>
      <p style={{ color: "#94a3b8", marginTop: 0 }}>
        Credentials the bot uses to look up a driver's live truck GPS. Samsara is the primary source;
        Factor ELD and Leader ELD (Drive HoS) are the fallbacks, tried in that order.
      </p>
      <Banner message={message} />

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>Test unit number (optional)</label>
          <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 6 }}>Enter a unit number to check a specific truck; blank just verifies the credentials.</div>
          <input className="form-input" style={{ maxWidth: 240 }} value={testUnit} placeholder="e.g. 2614" onChange={(e) => setTestUnit(e.target.value)} />
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>🛰️ Samsara <span style={{ fontSize: 12, color: "#94a3b8" }}>(primary)</span></h3>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14 }}>
            <input type="checkbox" checked={form.samsaraEnabled} onChange={(e) => setField("samsaraEnabled", e.target.checked)} /> Enabled
          </label>
        </div>
        <KeyField label="Samsara API Key" hint={settings.samsaraApiKeySet ? settings.samsaraApiKeyMasked : "not set"} fromEnv={settings.samsaraFromEnv} value={form.samsaraApiKey} onChange={(v) => setField("samsaraApiKey", v)} />
        <button className="btn btn-ghost btn-sm" onClick={() => runTest("samsara", { apiKey: form.samsaraApiKey.trim() || undefined })} disabled={testing.samsara}>Test connection</button>
        <TestBadge provider="samsara" /><TestMessage provider="samsara" />
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>🔗 Drive HoS (Factor &amp; Leader platform)</h3>
        <p style={{ fontSize: 13, color: "#94a3b8", marginTop: 0 }}>The shared <code>X-API-Provider-Key</code> identifies our integration and is used for both Factor and Leader requests.</p>
        <KeyField label="Provider Key (X-API-Provider-Key)" hint={settings.driveHosProviderKeySet ? settings.driveHosProviderKeyMasked : "not set"} fromEnv={settings.driveHosProviderFromEnv} value={form.driveHosProviderKey} onChange={(v) => setField("driveHosProviderKey", v)} />
        <div className="form-group">
          <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>API Base URL</label>
          <input className="form-input" value={form.driveHosApiBase} placeholder="https://api.drivehos.app" onChange={(e) => setField("driveHosApiBase", e.target.value)} />
          <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>
            The real API host (e.g. <code>https://api.drivehos.app</code>) — <strong>not</strong> the Swagger/documentation page.
          </div>
          {apiBaseIsDocs && (
            <div style={{ fontSize: 12, color: "#f87171", marginTop: 6, fontWeight: 600 }}>
              ⚠️ This looks like a documentation URL, not the actual API base URL. Requests will fail until this points at the real API host.
            </div>
          )}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>🚛 Factor ELD <span style={{ fontSize: 12, color: "#94a3b8" }}>(fallback 1)</span></h3>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14 }}>
            <input type="checkbox" checked={form.factorEnabled} onChange={(e) => setField("factorEnabled", e.target.checked)} /> Enabled
          </label>
        </div>
        <KeyField label="Factor Company Key (X-API-Company-Key)" hint={settings.factorCompanyKeySet ? settings.factorCompanyKeyMasked : "not set"} fromEnv={settings.factorFromEnv} value={form.factorCompanyKey} onChange={(v) => setField("factorCompanyKey", v)} />
        <button className="btn btn-ghost btn-sm" onClick={() => runTest("factor", { companyKey: form.factorCompanyKey.trim() || undefined, providerKey: form.driveHosProviderKey.trim() || undefined })} disabled={testing.factor}>Test connection</button>
        <TestBadge provider="factor" /><TestMessage provider="factor" />
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>🚛 Leader ELD <span style={{ fontSize: 12, color: "#94a3b8" }}>(fallback 2)</span></h3>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14 }}>
            <input type="checkbox" checked={form.leaderEnabled} onChange={(e) => setField("leaderEnabled", e.target.checked)} /> Enabled
          </label>
        </div>
        <KeyField label="Leader Company Key (X-API-Company-Key)" hint={settings.leaderCompanyKeySet ? settings.leaderCompanyKeyMasked : "not set"} fromEnv={settings.leaderFromEnv} value={form.leaderCompanyKey} onChange={(v) => setField("leaderCompanyKey", v)} />
        <button className="btn btn-ghost btn-sm" onClick={() => runTest("leader", { companyKey: form.leaderCompanyKey.trim() || undefined, providerKey: form.driveHosProviderKey.trim() || undefined })} disabled={testing.leader}>Test connection</button>
        <TestBadge provider="leader" /><TestMessage provider="leader" />
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save settings"}</button>
        {settings.updatedAt && <span style={{ fontSize: 12, color: "#94a3b8" }}>Last updated {new Date(settings.updatedAt).toLocaleString()}</span>}
      </div>
    </div>
  );
}
