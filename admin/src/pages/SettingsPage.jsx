import React, { useCallback, useEffect, useState } from "react";
import * as api from "../api";

/**
 * Settings — two tabs:
 *   • Live Location  — GPS provider credentials (Samsara + Factor/Leader ELD)
 *   • RingCentral    — call-KPI credentials, targets/thresholds, and the
 *                      recruiter ↔ phone-number assignments
 *
 * Secrets are write-only from the UI: the API returns only a masked "••••abcd"
 * hint and never the raw value. Leaving a key field blank on Save keeps the
 * stored value.
 */

function KeyField({ label, hint, value, onChange, placeholder, fromEnv, type = "password" }) {
  return (
    <div className="form-group">
      <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>{label}</label>
      {hint && (
        <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 6 }}>
          Currently: <strong>{hint}</strong>{fromEnv ? " (from environment)" : ""}
        </div>
      )}
      <input
        className="form-input"
        type={type}
        autoComplete="new-password"
        value={value}
        placeholder={placeholder || "Leave blank to keep current"}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function NumField({ label, value, onChange, suffix }) {
  return (
    <div className="form-group" style={{ marginBottom: 12 }}>
      <label style={{ display: "block", fontWeight: 600, marginBottom: 4, fontSize: 13 }}>{label}</label>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          className="form-input"
          type="number"
          style={{ maxWidth: 140 }}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        {suffix && <span style={{ fontSize: 12, color: "#94a3b8" }}>{suffix}</span>}
      </div>
    </div>
  );
}

function Banner({ message }) {
  if (!message) return null;
  return <div className={`alert alert-${message.type === "error" ? "error" : "success"}`}>{message.text}</div>;
}

// ─────────────────────────────── Live Location tab ───────────────────────────

function LocationProvidersTab() {
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

  const runTest = async (provider, candidate = {}) => {
    setTesting((t) => ({ ...t, [provider]: true }));
    setTestResults((r) => ({ ...r, [provider]: null }));
    try {
      const groupTitle = testUnit.trim() ? `UNIT # ${testUnit.trim()}` : "";
      const result = await api.testEldProvider({ provider, groupTitle, ...candidate });
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

// ─────────────────────────────── RingCentral tab ─────────────────────────────

function RingCentralTab() {
  const [settings, setSettings] = useState(null);
  const [recruiters, setRecruiters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [test, setTest] = useState(null);
  const [testing, setTesting] = useState(false);
  const [form, setForm] = useState({
    clientId: "", clientSecret: "", jwtToken: "", apiBase: "",
    enabled: false, pollMinutes: 10, timezone: "America/Chicago",
    nonValuableMaxSeconds: 30, realConversationMinSeconds: 60, strongConversationMinSeconds: 180,
    targetOutbound: 150, targetRealConversations: 35,
  });
  const [newRec, setNewRec] = useState({ name: "", phoneNumber: "" });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, recs] = await Promise.all([api.getRingCentralSettings(), api.getRecruiters()]);
      setSettings(s);
      setRecruiters(recs);
      setForm((f) => ({
        ...f, apiBase: s.apiBase || "", enabled: s.enabled, pollMinutes: s.pollMinutes,
        timezone: s.timezone || "America/Chicago", nonValuableMaxSeconds: s.nonValuableMaxSeconds,
        realConversationMinSeconds: s.realConversationMinSeconds, strongConversationMinSeconds: s.strongConversationMinSeconds,
        targetOutbound: s.targetOutbound, targetRealConversations: s.targetRealConversations,
      }));
    } catch (err) { setMessage({ type: "error", text: err.message }); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const setField = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setSaving(true); setMessage(null);
    try {
      const payload = {
        enabled: form.enabled, apiBase: form.apiBase, pollMinutes: Number(form.pollMinutes),
        timezone: form.timezone, nonValuableMaxSeconds: Number(form.nonValuableMaxSeconds),
        realConversationMinSeconds: Number(form.realConversationMinSeconds),
        strongConversationMinSeconds: Number(form.strongConversationMinSeconds),
        targetOutbound: Number(form.targetOutbound), targetRealConversations: Number(form.targetRealConversations),
      };
      if (form.clientId.trim()) payload.clientId = form.clientId.trim();
      if (form.clientSecret.trim()) payload.clientSecret = form.clientSecret.trim();
      if (form.jwtToken.trim()) payload.jwtToken = form.jwtToken.trim();
      const s = await api.updateRingCentralSettings(payload);
      setSettings(s);
      setForm((f) => ({ ...f, clientId: "", clientSecret: "", jwtToken: "" }));
      setMessage({ type: "success", text: "RingCentral settings saved." });
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

  const addRecruiter = async () => {
    if (!newRec.name.trim() || !newRec.phoneNumber.trim()) {
      setMessage({ type: "error", text: "Recruiter name and phone number are required." });
      return;
    }
    try {
      await api.createRecruiter({ name: newRec.name.trim(), phoneNumber: newRec.phoneNumber.trim() });
      setNewRec({ name: "", phoneNumber: "" });
      setRecruiters(await api.getRecruiters());
      setMessage({ type: "success", text: "Recruiter added." });
    } catch (err) { setMessage({ type: "error", text: err.message }); }
  };

  const toggleRecruiter = async (r) => {
    try { await api.updateRecruiter(r.id, { active: !r.active }); setRecruiters(await api.getRecruiters()); }
    catch (err) { setMessage({ type: "error", text: err.message }); }
  };

  const removeRecruiter = async (r) => {
    if (!window.confirm(`Remove recruiter "${r.name}"? Their historical call stats will be unassigned.`)) return;
    try { await api.deleteRecruiter(r.id); setRecruiters(await api.getRecruiters()); }
    catch (err) { setMessage({ type: "error", text: err.message }); }
  };

  if (loading) return <div className="loading"><div className="spinner"></div> Loading…</div>;

  return (
    <div>
      <p style={{ color: "#94a3b8", marginTop: 0 }}>
        RingCentral call-log monitoring for recruiter KPIs. The bot polls the company call log,
        attributes each call to a recruiter by their dedicated direct number, and scores it against
        the daily targets.
      </p>
      <Banner message={message} />

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>📞 RingCentral Credentials</h3>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14 }}>
            <input type="checkbox" checked={form.enabled} onChange={(e) => setField("enabled", e.target.checked)} /> Monitoring enabled
          </label>
        </div>
        <p style={{ fontSize: 13, color: "#94a3b8", marginTop: 0 }}>
          JWT auth (server-side). The JWT app needs the <strong>Read Call Log</strong> permission and an admin-role user.
        </p>
        <KeyField label="Client ID" hint={settings.clientIdSet ? settings.clientIdMasked : "not set"} fromEnv={settings.fromEnv?.clientId} value={form.clientId} onChange={(v) => setField("clientId", v)} />
        <KeyField label="Client Secret" hint={settings.clientSecretSet ? settings.clientSecretMasked : "not set"} fromEnv={settings.fromEnv?.clientSecret} value={form.clientSecret} onChange={(v) => setField("clientSecret", v)} />
        <KeyField label="JWT Token" hint={settings.jwtTokenSet ? settings.jwtTokenMasked : "not set"} fromEnv={settings.fromEnv?.jwtToken} value={form.jwtToken} onChange={(v) => setField("jwtToken", v)} />
        <div className="form-group">
          <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>API Base URL</label>
          <input className="form-input" value={form.apiBase} placeholder="https://platform.ringcentral.com" onChange={(e) => setField("apiBase", e.target.value)} />
          <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>Use <code>https://platform.ringcentral.com</code> for production, <code>https://platform.devtest.ringcentral.com</code> for sandbox.</div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={runTest} disabled={testing}>{testing ? "Testing…" : "Test connection"}</button>
        {test && <span className={`badge ${test.connected ? "badge-active" : "badge-inactive"}`} style={{ marginLeft: 8 }}>{test.connected ? "✓ Connected" : "✕ Not connected"}</span>}
        {test?.message && <div style={{ fontSize: 12, color: test.connected ? "#22c55e" : "#f87171", marginTop: 4 }}>{test.message}</div>}
        {settings.lastSyncedAt && <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 8 }}>Last sync: {new Date(settings.lastSyncedAt).toLocaleString()}{settings.lastSyncError ? ` · ⚠️ ${settings.lastSyncError}` : ""}</div>}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>🎯 Daily Targets &amp; Conversation Thresholds</h3>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 24 }}>
          <div>
            <NumField label="Total Outbound target" value={form.targetOutbound} onChange={(v) => setField("targetOutbound", v)} suffix="calls/day" />
            <NumField label="Real Conversations target" value={form.targetRealConversations} onChange={(v) => setField("targetRealConversations", v)} suffix="calls/day" />
          </div>
          <div>
            <NumField label="Non-valuable (under)" value={form.nonValuableMaxSeconds} onChange={(v) => setField("nonValuableMaxSeconds", v)} suffix="seconds" />
            <NumField label="Real conversation (over)" value={form.realConversationMinSeconds} onChange={(v) => setField("realConversationMinSeconds", v)} suffix="seconds" />
            <NumField label="Strong conversation (over)" value={form.strongConversationMinSeconds} onChange={(v) => setField("strongConversationMinSeconds", v)} suffix="seconds" />
          </div>
          <div>
            <NumField label="Poll interval" value={form.pollMinutes} onChange={(v) => setField("pollMinutes", v)} suffix="minutes" />
            <div className="form-group" style={{ marginBottom: 12 }}>
              <label style={{ display: "block", fontWeight: 600, marginBottom: 4, fontSize: 13 }}>Day timezone</label>
              <input className="form-input" style={{ maxWidth: 200 }} value={form.timezone} onChange={(e) => setField("timezone", e.target.value)} />
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 24 }}>
        <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save settings"}</button>
        {settings.updatedAt && <span style={{ fontSize: 12, color: "#94a3b8" }}>Last updated {new Date(settings.updatedAt).toLocaleString()}</span>}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>👤 Recruiters &amp; Assigned Numbers</h3>
        <p style={{ fontSize: 13, color: "#94a3b8", marginTop: 0 }}>Each recruiter has one dedicated RingCentral direct number. Calls on that number (in or out) roll up to them.</p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 16 }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label style={{ display: "block", fontSize: 12, marginBottom: 4 }}>Recruiter name</label>
            <input className="form-input" value={newRec.name} placeholder="Jane Doe" onChange={(e) => setNewRec((n) => ({ ...n, name: e.target.value }))} />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label style={{ display: "block", fontSize: 12, marginBottom: 4 }}>RingCentral number</label>
            <input className="form-input" value={newRec.phoneNumber} placeholder="+1 (470) 480-4679" onChange={(e) => setNewRec((n) => ({ ...n, phoneNumber: e.target.value }))} />
          </div>
          <button className="btn btn-primary btn-sm" onClick={addRecruiter}>Add recruiter</button>
        </div>

        {recruiters.length === 0 ? (
          <div style={{ fontSize: 13, color: "#94a3b8" }}>No recruiters yet.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#94a3b8", fontSize: 12 }}>
                <th style={{ padding: "6px 8px" }}>Name</th>
                <th style={{ padding: "6px 8px" }}>Number</th>
                <th style={{ padding: "6px 8px" }}>Status</th>
                <th style={{ padding: "6px 8px" }}></th>
              </tr>
            </thead>
            <tbody>
              {recruiters.map((r) => (
                <tr key={r.id} style={{ borderTop: "1px solid rgba(148,163,184,0.15)" }}>
                  <td style={{ padding: "8px" }}>{r.name}</td>
                  <td style={{ padding: "8px", fontFamily: "monospace" }}>{r.phone_number}</td>
                  <td style={{ padding: "8px" }}>
                    <span className={`badge ${r.active ? "badge-active" : "badge-inactive"}`}>{r.active ? "Active" : "Inactive"}</span>
                  </td>
                  <td style={{ padding: "8px", textAlign: "right" }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => toggleRecruiter(r)}>{r.active ? "Deactivate" : "Activate"}</button>
                    <button className="btn btn-danger btn-sm" style={{ marginLeft: 6 }} onClick={() => removeRecruiter(r)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────── Page shell ──────────────────────────────────

export default function SettingsPage() {
  const [tab, setTab] = useState("location");
  return (
    <div>
      <div className="page-header">
        <h2>⚙️ Settings</h2>
        <p>Integration credentials and configuration for the bot's external services.</p>
      </div>
      <div className="ios-glass ai-tab-bar" style={{ marginBottom: 20 }}>
        <button className={`btn ${tab === "location" ? "btn-primary" : "btn-ghost"} touch-target`} onClick={() => setTab("location")}>📡 Live Location</button>
        <button className={`btn ${tab === "ringcentral" ? "btn-primary" : "btn-ghost"} touch-target`} onClick={() => setTab("ringcentral")}>📞 RingCentral</button>
      </div>
      {tab === "location" ? <LocationProvidersTab /> : <RingCentralTab />}
    </div>
  );
}
