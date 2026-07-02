import React, { useCallback, useEffect, useState } from "react";
import * as api from "../api";

/**
 * Settings → Live-Location Providers.
 *
 * Samsara is the primary GPS source; Factor ELD and Leader ELD (both on the
 * Drive HoS platform) are the fallbacks, tried in that order. Secrets are
 * write-only from here: the API returns only a masked "••••abcd" hint and never
 * the raw key. Leaving a key field blank on Save keeps the stored value.
 */

function KeyField({ label, hint, value, onChange, placeholder, fromEnv }) {
  return (
    <div className="form-group">
      <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>{label}</label>
      {hint && (
        <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 6 }}>
          Currently: <strong>{hint}</strong>
          {fromEnv ? " (from environment)" : ""}
        </div>
      )}
      <input
        className="form-input"
        type="password"
        autoComplete="new-password"
        value={value}
        placeholder={placeholder || "Leave blank to keep current"}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

export default function SettingsPage() {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [testResults, setTestResults] = useState({});
  const [testing, setTesting] = useState({});
  const [testUnit, setTestUnit] = useState("");

  // Draft (write-only) key inputs and toggles.
  const [form, setForm] = useState({
    samsaraApiKey: "",
    driveHosProviderKey: "",
    driveHosApiBase: "",
    factorCompanyKey: "",
    leaderCompanyKey: "",
    samsaraEnabled: true,
    factorEnabled: true,
    leaderEnabled: true,
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const s = await api.getEldSettings();
      setSettings(s);
      setForm((f) => ({
        ...f,
        driveHosApiBase: s.driveHosApiBase || "",
        samsaraEnabled: s.samsaraEnabled,
        factorEnabled: s.factorEnabled,
        leaderEnabled: s.leaderEnabled,
      }));
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const setField = (key, val) => setForm((f) => ({ ...f, [key]: val }));

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const payload = {
        samsaraEnabled: form.samsaraEnabled,
        factorEnabled: form.factorEnabled,
        leaderEnabled: form.leaderEnabled,
        driveHosApiBase: form.driveHosApiBase,
      };
      // Only send secrets the operator actually typed.
      if (form.samsaraApiKey.trim()) payload.samsaraApiKey = form.samsaraApiKey.trim();
      if (form.driveHosProviderKey.trim()) payload.driveHosProviderKey = form.driveHosProviderKey.trim();
      if (form.factorCompanyKey.trim()) payload.factorCompanyKey = form.factorCompanyKey.trim();
      if (form.leaderCompanyKey.trim()) payload.leaderCompanyKey = form.leaderCompanyKey.trim();

      const s = await api.updateEldSettings(payload);
      setSettings(s);
      setForm((f) => ({
        ...f,
        samsaraApiKey: "",
        driveHosProviderKey: "",
        factorCompanyKey: "",
        leaderCompanyKey: "",
      }));
      setMessage({ type: "success", text: "Settings saved." });
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setSaving(false);
    }
  };

  const runTest = async (provider, candidate = {}) => {
    setTesting((t) => ({ ...t, [provider]: true }));
    setTestResults((r) => ({ ...r, [provider]: null }));
    try {
      const groupTitle = testUnit.trim() ? `UNIT # ${testUnit.trim()}` : "";
      const result = await api.testEldProvider({ provider, groupTitle, ...candidate });
      setTestResults((r) => ({ ...r, [provider]: result }));
    } catch (err) {
      setTestResults((r) => ({ ...r, [provider]: { connected: false, message: err.message } }));
    } finally {
      setTesting((t) => ({ ...t, [provider]: false }));
    }
  };

  if (loading) {
    return (
      <div className="loading"><div className="spinner"></div> Loading settings...</div>
    );
  }

  const TestBadge = ({ provider }) => {
    const r = testResults[provider];
    if (testing[provider]) return <span className="badge badge-muted">Testing…</span>;
    if (!r) return null;
    return (
      <span
        className={`badge ${r.connected ? "badge-active" : "badge-inactive"}`}
        style={{ marginLeft: 8 }}
        title={r.message}
      >
        {r.connected ? "✓ Connected" : "✕ Not connected"}
      </span>
    );
  };

  const TestMessage = ({ provider }) => {
    const r = testResults[provider];
    if (!r || !r.message) return null;
    return (
      <div style={{ fontSize: 12, color: r.connected ? "#22c55e" : "#f87171", marginTop: 4 }}>
        {r.message}
      </div>
    );
  };

  return (
    <div>
      <div className="page-header">
        <h2>⚙️ Settings — Live-Location Providers</h2>
        <p>
          Credentials the bot uses to look up a driver's live truck GPS. Samsara is the
          primary source; Factor ELD and Leader ELD (Drive HoS) are the fallbacks, tried
          in that order.
        </p>
      </div>

      {message && <div className={`alert alert-${message.type === "error" ? "error" : "success"}`}>{message.text}</div>}

      {/* Shared test control */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>
            Test unit number (optional)
          </label>
          <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 6 }}>
            Enter a truck/unit number to check whether a provider can locate that specific
            truck. Leave blank to just verify the credentials connect.
          </div>
          <input
            className="form-input"
            style={{ maxWidth: 240 }}
            value={testUnit}
            placeholder="e.g. 2614"
            onChange={(e) => setTestUnit(e.target.value)}
          />
        </div>
      </div>

      {/* Samsara */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>🛰️ Samsara <span style={{ fontSize: 12, color: "#94a3b8" }}>(primary)</span></h3>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14 }}>
            <input type="checkbox" checked={form.samsaraEnabled} onChange={(e) => setField("samsaraEnabled", e.target.checked)} />
            Enabled
          </label>
        </div>
        <KeyField
          label="Samsara API Key"
          hint={settings.samsaraApiKeySet ? settings.samsaraApiKeyMasked : "not set"}
          fromEnv={settings.samsaraFromEnv}
          value={form.samsaraApiKey}
          onChange={(v) => setField("samsaraApiKey", v)}
        />
        <div>
          <button className="btn btn-ghost btn-sm" onClick={() => runTest("samsara", { apiKey: form.samsaraApiKey.trim() || undefined })} disabled={testing.samsara}>
            Test connection
          </button>
          <TestBadge provider="samsara" />
          <TestMessage provider="samsara" />
        </div>
      </div>

      {/* Drive HoS shared provider key */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>🔗 Drive HoS (Factor &amp; Leader platform)</h3>
        <p style={{ fontSize: 13, color: "#94a3b8", marginTop: 0 }}>
          The shared <code>X-API-Provider-Key</code> identifies our integration
          (AlgoService) and is used for both Factor and Leader requests.
        </p>
        <KeyField
          label="Provider Key (X-API-Provider-Key)"
          hint={settings.driveHosProviderKeySet ? settings.driveHosProviderKeyMasked : "not set"}
          fromEnv={settings.driveHosProviderFromEnv}
          value={form.driveHosProviderKey}
          onChange={(v) => setField("driveHosProviderKey", v)}
        />
        <div className="form-group">
          <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>API Base URL</label>
          <input
            className="form-input"
            value={form.driveHosApiBase}
            placeholder="https://api.drivehos.app"
            onChange={(e) => setField("driveHosApiBase", e.target.value)}
          />
        </div>
      </div>

      {/* Factor ELD */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>🚛 Factor ELD <span style={{ fontSize: 12, color: "#94a3b8" }}>(fallback 1)</span></h3>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14 }}>
            <input type="checkbox" checked={form.factorEnabled} onChange={(e) => setField("factorEnabled", e.target.checked)} />
            Enabled
          </label>
        </div>
        <KeyField
          label="Factor Company Key (X-API-Company-Key)"
          hint={settings.factorCompanyKeySet ? settings.factorCompanyKeyMasked : "not set"}
          fromEnv={settings.factorFromEnv}
          value={form.factorCompanyKey}
          onChange={(v) => setField("factorCompanyKey", v)}
        />
        <div>
          <button className="btn btn-ghost btn-sm" onClick={() => runTest("factor", { companyKey: form.factorCompanyKey.trim() || undefined, providerKey: form.driveHosProviderKey.trim() || undefined })} disabled={testing.factor}>
            Test connection
          </button>
          <TestBadge provider="factor" />
          <TestMessage provider="factor" />
        </div>
      </div>

      {/* Leader ELD */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>🚛 Leader ELD <span style={{ fontSize: 12, color: "#94a3b8" }}>(fallback 2)</span></h3>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14 }}>
            <input type="checkbox" checked={form.leaderEnabled} onChange={(e) => setField("leaderEnabled", e.target.checked)} />
            Enabled
          </label>
        </div>
        <KeyField
          label="Leader Company Key (X-API-Company-Key)"
          hint={settings.leaderCompanyKeySet ? settings.leaderCompanyKeyMasked : "not set"}
          fromEnv={settings.leaderFromEnv}
          value={form.leaderCompanyKey}
          onChange={(v) => setField("leaderCompanyKey", v)}
        />
        <div>
          <button className="btn btn-ghost btn-sm" onClick={() => runTest("leader", { companyKey: form.leaderCompanyKey.trim() || undefined, providerKey: form.driveHosProviderKey.trim() || undefined })} disabled={testing.leader}>
            Test connection
          </button>
          <TestBadge provider="leader" />
          <TestMessage provider="leader" />
        </div>
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save settings"}
        </button>
        {settings.updatedAt && (
          <span style={{ fontSize: 12, color: "#94a3b8" }}>
            Last updated {new Date(settings.updatedAt).toLocaleString()}
          </span>
        )}
      </div>
    </div>
  );
}
