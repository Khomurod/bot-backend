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

// ─────────────────────────────── RingCentral tab ─────────────────────────────

/**
 * One recruiter row: name + dedicated number, that number's own JWT token, and
 * a choice between the shared Client ID/Secret (from the credentials card
 * above) or a custom pair for this number. Per-number Test + Diagnose buttons
 * verify the credentials live.
 */
function RecruiterCard({ recruiter, onSaved, onDeleted, onMessage }) {
  const [expanded, setExpanded] = useState(false);
  const [form, setForm] = useState({ name: recruiter.name, phoneNumber: recruiter.phone_number, jwtToken: "", clientId: "", clientSecret: "" });
  const [useCustom, setUseCustom] = useState(recruiter.usesCustomClient);
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState(null);
  const [testing, setTesting] = useState(false);
  const [diag, setDiag] = useState(null);
  const [diagnosing, setDiagnosing] = useState(false);

  const setField = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setSaving(true);
    try {
      const payload = { name: form.name, phoneNumber: form.phoneNumber };
      if (form.jwtToken.trim()) payload.jwtToken = form.jwtToken.trim();
      if (useCustom) {
        if (form.clientId.trim()) payload.clientId = form.clientId.trim();
        if (form.clientSecret.trim()) payload.clientSecret = form.clientSecret.trim();
      } else if (recruiter.usesCustomClient) {
        // Switched back to the shared pair — clear the stored custom pair.
        payload.clearClientCreds = true;
      }
      await api.updateRecruiter(recruiter.id, payload);
      setForm((f) => ({ ...f, jwtToken: "", clientId: "", clientSecret: "" }));
      onMessage({ type: "success", text: `${form.name || recruiter.name} saved.` });
      await onSaved();
    } catch (err) { onMessage({ type: "error", text: err.message }); }
    finally { setSaving(false); }
  };

  const candidateCreds = () => ({
    jwtToken: form.jwtToken.trim() || undefined,
    clientId: useCustom ? (form.clientId.trim() || undefined) : undefined,
    clientSecret: useCustom ? (form.clientSecret.trim() || undefined) : undefined,
  });

  const runTest = async () => {
    setTesting(true); setTest(null);
    try { setTest(await api.testRecruiterConnection(recruiter.id, candidateCreds())); }
    catch (err) { setTest({ connected: false, message: err.message }); }
    finally { setTesting(false); }
  };

  const runDiagnose = async () => {
    setDiagnosing(true); setDiag(null);
    try { setDiag(await api.diagnoseRecruiter(recruiter.id, candidateCreds())); }
    catch (err) { setDiag({ ok: false, steps: [{ label: "Diagnostic", ok: false, detail: err.message }] }); }
    finally { setDiagnosing(false); }
  };

  const toggleActive = async () => {
    try { await api.updateRecruiter(recruiter.id, { active: !recruiter.active }); await onSaved(); }
    catch (err) { onMessage({ type: "error", text: err.message }); }
  };

  const remove = async () => {
    if (!window.confirm(`Remove recruiter "${recruiter.name}"? Their historical call stats will be unassigned.`)) return;
    try { await api.deleteRecruiter(recruiter.id); await onDeleted(); }
    catch (err) { onMessage({ type: "error", text: err.message }); }
  };

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <strong>{recruiter.name}</strong>
          <span style={{ fontFamily: "monospace", fontSize: 13, color: "#94a3b8" }}>{recruiter.phone_number}</span>
          <span className={`badge ${recruiter.active ? "badge-active" : "badge-inactive"}`}>{recruiter.active ? "Active" : "Inactive"}</span>
          <span className={`badge ${recruiter.jwtTokenSet ? "badge-active" : "badge-inactive"}`} title={recruiter.jwtTokenSet ? `JWT ${recruiter.jwtTokenMasked}` : "No JWT — falls back to shared company-log matching"}>
            {recruiter.jwtTokenSet ? "JWT set" : "No JWT"}
          </span>
          <span className="badge badge-muted">{recruiter.usesCustomClient ? "Custom app creds" : "Shared app creds"}</span>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button className="btn btn-ghost btn-sm" onClick={runTest} disabled={testing}>{testing ? "Testing…" : "Test connection"}</button>
          <button className="btn btn-ghost btn-sm" onClick={runDiagnose} disabled={diagnosing}>{diagnosing ? "Diagnosing…" : "Diagnose"}</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setExpanded((e) => !e)}>{expanded ? "Close" : "Edit"}</button>
        </div>
      </div>

      {test && (
        <div style={{ fontSize: 12, marginTop: 8, color: test.connected ? "#22c55e" : "#f87171" }}>
          {test.connected ? "✓" : "✕"} {test.message}
        </div>
      )}

      {diag && (
        <div style={{ marginTop: 10, padding: 10, borderRadius: 8, background: "rgba(148,163,184,0.08)" }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: diag.ok ? "#22c55e" : "#f87171" }}>
            {diag.ok ? "✓ All checks passed" : "✕ Issues found"}
          </div>
          {(diag.steps || []).map((s, idx) => (
            <div key={idx} style={{ fontSize: 12, marginBottom: 4 }}>
              <span style={{ color: s.ok ? "#22c55e" : "#f87171" }}>{s.ok ? "✓" : "✕"}</span>{" "}
              <strong style={{ color: "#cbd5e1" }}>{s.label}:</strong>{" "}
              <span style={{ color: "#94a3b8" }}>{s.detail}</span>
            </div>
          ))}
        </div>
      )}

      {expanded && (
        <div style={{ marginTop: 12, borderTop: "1px solid rgba(148,163,184,0.15)", paddingTop: 12 }}>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <div className="form-group" style={{ marginBottom: 8 }}>
              <label style={{ display: "block", fontSize: 12, marginBottom: 4 }}>Name</label>
              <input className="form-input" value={form.name} onChange={(e) => setField("name", e.target.value)} />
            </div>
            <div className="form-group" style={{ marginBottom: 8 }}>
              <label style={{ display: "block", fontSize: 12, marginBottom: 4 }}>RingCentral number</label>
              <input className="form-input" value={form.phoneNumber} onChange={(e) => setField("phoneNumber", e.target.value)} />
            </div>
          </div>
          <KeyField
            label="JWT Token (this number's own)"
            hint={recruiter.jwtTokenSet ? recruiter.jwtTokenMasked : "not set"}
            value={form.jwtToken}
            onChange={(v) => setField("jwtToken", v)}
          />
          <div className="form-group" style={{ marginBottom: 8 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
              <input type="checkbox" checked={useCustom} onChange={(e) => setUseCustom(e.target.checked)} />
              Use a custom Client ID / Client Secret for this number
            </label>
            <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>
              Off = this number authenticates with the shared Client ID/Secret from the credentials card above.
            </div>
          </div>
          {useCustom && (
            <div style={{ paddingLeft: 12, borderLeft: "2px solid rgba(148,163,184,0.25)" }}>
              <KeyField label="Custom Client ID" hint={recruiter.clientIdSet ? recruiter.clientIdMasked : "not set"} value={form.clientId} onChange={(v) => setField("clientId", v)} />
              <KeyField label="Custom Client Secret" hint={recruiter.clientSecretSet ? recruiter.clientSecretMasked : "not set"} value={form.clientSecret} onChange={(v) => setField("clientSecret", v)} />
            </div>
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
            <button className="btn btn-primary btn-sm" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
            <button className="btn btn-ghost btn-sm" onClick={toggleActive}>{recruiter.active ? "Deactivate" : "Activate"}</button>
            <button className="btn btn-danger btn-sm" onClick={remove}>Delete</button>
          </div>
        </div>
      )}
    </div>
  );
}

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
  const [newRec, setNewRec] = useState({ name: "", phoneNumber: "", jwtToken: "", clientId: "", clientSecret: "", useCustom: false });

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

  const refreshRecruiters = useCallback(async () => {
    setRecruiters(await api.getRecruiters());
  }, []);

  const addRecruiter = async () => {
    if (!newRec.name.trim() || !newRec.phoneNumber.trim()) {
      setMessage({ type: "error", text: "Recruiter name and phone number are required." });
      return;
    }
    try {
      const payload = { name: newRec.name.trim(), phoneNumber: newRec.phoneNumber.trim() };
      if (newRec.jwtToken.trim()) payload.jwtToken = newRec.jwtToken.trim();
      if (newRec.useCustom) {
        if (newRec.clientId.trim()) payload.clientId = newRec.clientId.trim();
        if (newRec.clientSecret.trim()) payload.clientSecret = newRec.clientSecret.trim();
      }
      await api.createRecruiter(payload);
      setNewRec({ name: "", phoneNumber: "", jwtToken: "", clientId: "", clientSecret: "", useCustom: false });
      await refreshRecruiters();
      setMessage({ type: "success", text: "Recruiter added. Use Test connection / Diagnose on the row to verify." });
    } catch (err) { setMessage({ type: "error", text: err.message }); }
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
          The <strong>shared Client ID/Secret</strong> are used by every number that doesn't have
          its own custom pair. Each number's own JWT token is entered on the recruiter row below.
          The shared JWT is optional — it's only used as a company-log fallback for numbers
          without their own JWT (that path needs an admin-role user with <strong>Read Call Log</strong>).
        </p>
        <KeyField label="Shared Client ID" hint={settings.clientIdSet ? settings.clientIdMasked : "not set"} fromEnv={settings.fromEnv?.clientId} value={form.clientId} onChange={(v) => setField("clientId", v)} />
        <KeyField label="Shared Client Secret" hint={settings.clientSecretSet ? settings.clientSecretMasked : "not set"} fromEnv={settings.fromEnv?.clientSecret} value={form.clientSecret} onChange={(v) => setField("clientSecret", v)} />
        <KeyField label="Shared JWT Token (optional fallback)" hint={settings.jwtTokenSet ? settings.jwtTokenMasked : "not set"} fromEnv={settings.fromEnv?.jwtToken} value={form.jwtToken} onChange={(v) => setField("jwtToken", v)} />
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

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>➕ Add Recruiter &amp; Number</h3>
        <p style={{ fontSize: 13, color: "#94a3b8", marginTop: 0 }}>
          Each recruiter has one dedicated RingCentral direct number, and each number has its own
          JWT token. The Client ID/Secret default to the shared pair above; tick the checkbox to
          use a separate pair for this number.
        </p>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <div className="form-group" style={{ marginBottom: 8 }}>
            <label style={{ display: "block", fontSize: 12, marginBottom: 4 }}>Recruiter name</label>
            <input className="form-input" value={newRec.name} placeholder="Jane Doe" onChange={(e) => setNewRec((n) => ({ ...n, name: e.target.value }))} />
          </div>
          <div className="form-group" style={{ marginBottom: 8 }}>
            <label style={{ display: "block", fontSize: 12, marginBottom: 4 }}>RingCentral number</label>
            <input className="form-input" value={newRec.phoneNumber} placeholder="+1 (470) 480-4679" onChange={(e) => setNewRec((n) => ({ ...n, phoneNumber: e.target.value }))} />
          </div>
        </div>
        <div className="form-group" style={{ marginBottom: 8 }}>
          <label style={{ display: "block", fontSize: 12, marginBottom: 4 }}>JWT Token (this number's own)</label>
          <input className="form-input" type="password" autoComplete="new-password" value={newRec.jwtToken} placeholder="Paste the JWT for this number's user" onChange={(e) => setNewRec((n) => ({ ...n, jwtToken: e.target.value }))} />
        </div>
        <div className="form-group" style={{ marginBottom: 8 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <input type="checkbox" checked={newRec.useCustom} onChange={(e) => setNewRec((n) => ({ ...n, useCustom: e.target.checked }))} />
            Use a custom Client ID / Client Secret for this number
          </label>
        </div>
        {newRec.useCustom && (
          <div style={{ paddingLeft: 12, borderLeft: "2px solid rgba(148,163,184,0.25)", marginBottom: 8 }}>
            <div className="form-group" style={{ marginBottom: 8 }}>
              <label style={{ display: "block", fontSize: 12, marginBottom: 4 }}>Custom Client ID</label>
              <input className="form-input" type="password" autoComplete="new-password" value={newRec.clientId} onChange={(e) => setNewRec((n) => ({ ...n, clientId: e.target.value }))} />
            </div>
            <div className="form-group" style={{ marginBottom: 8 }}>
              <label style={{ display: "block", fontSize: 12, marginBottom: 4 }}>Custom Client Secret</label>
              <input className="form-input" type="password" autoComplete="new-password" value={newRec.clientSecret} onChange={(e) => setNewRec((n) => ({ ...n, clientSecret: e.target.value }))} />
            </div>
          </div>
        )}
        <button className="btn btn-primary btn-sm" onClick={addRecruiter}>Add recruiter</button>
      </div>

      <div style={{ marginBottom: 8 }}>
        <h3 style={{ margin: "0 0 4px" }}>👤 Recruiters &amp; Assigned Numbers</h3>
        <p style={{ fontSize: 13, color: "#94a3b8", marginTop: 0 }}>
          Use <strong>Test connection</strong> for a quick check or <strong>Diagnose</strong> for a
          step-by-step report (credentials → auth → number match → call-log read).
        </p>
      </div>
      {recruiters.length === 0 ? (
        <div className="card"><div style={{ fontSize: 13, color: "#94a3b8" }}>No recruiters yet.</div></div>
      ) : (
        recruiters.map((r) => (
          <RecruiterCard
            key={r.id}
            recruiter={r}
            onSaved={refreshRecruiters}
            onDeleted={refreshRecruiters}
            onMessage={setMessage}
          />
        ))
      )}
    </div>
  );
}

// ───────────────────────────── Telegram Groups tab ───────────────────────────

/**
 * One labeled Telegram group-ID field. Unlike credentials these are NOT secrets,
 * so the current value is shown and editable in plaintext.
 */
function GroupIdField({ label, help, placeholder, value, onChange, status }) {
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>{label}</label>
      <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 8 }}>{help}</div>
      <input
        className="form-input"
        style={{ maxWidth: 320, fontFamily: "monospace" }}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      <div style={{ marginTop: 6 }}>
        {status?.configured ? (
          <span className="badge badge-active">
            ✓ Configured{status.fromEnv ? " (from environment)" : ""}
          </span>
        ) : (
          <span className="badge badge-inactive">✕ Not configured — messages will not be sent</span>
        )}
      </div>
    </div>
  );
}

function TelegramGroupsTab() {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [form, setForm] = useState({ mileageBonus: "", roadBonus: "", dispatchReview: "" });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const s = await api.getMessageGroupSettings();
      setSettings(s);
      setForm({
        mileageBonus: s.mileageBonus?.groupId || "",
        roadBonus: s.roadBonus?.groupId || "",
        dispatchReview: s.dispatchReview?.groupId || "",
      });
    } catch (err) { setMessage({ type: "error", text: err.message }); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const setField = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setSaving(true); setMessage(null);
    try {
      const s = await api.updateMessageGroupSettings({
        mileageBonus: form.mileageBonus.trim(),
        roadBonus: form.roadBonus.trim(),
        dispatchReview: form.dispatchReview.trim(),
      });
      setSettings(s);
      setForm({
        mileageBonus: s.mileageBonus?.groupId || "",
        roadBonus: s.roadBonus?.groupId || "",
        dispatchReview: s.dispatchReview?.groupId || "",
      });
      setMessage({ type: "success", text: "Telegram group settings saved." });
    } catch (err) { setMessage({ type: "error", text: err.message }); }
    finally { setSaving(false); }
  };

  if (loading) return <div className="loading"><div className="spinner"></div> Loading…</div>;

  return (
    <div>
      <p style={{ color: "#94a3b8", marginTop: 0 }}>
        The Telegram group each message category is sent to. Enter the group's chat ID
        (e.g. <code>-1001234567890</code>). Each category has its own destination — enter the
        same ID in more than one field to share a group. If a field is left blank, that
        category's messages are <strong>not sent</strong> and a configuration error is logged
        (there is no hidden default).
      </p>
      <Banner message={message} />

      <GroupIdField
        label="Extra Mile / Mileage Bonus Telegram Group ID"
        help="Milestone bonus cards (10k / 40k / 100k … driven miles) for company drivers, with Paid / Rejected buttons."
        placeholder="e.g. -1001234567890"
        value={form.mileageBonus}
        onChange={(v) => setField("mileageBonus", v)}
        status={settings?.mileageBonus}
      />
      <GroupIdField
        label="Extra Week / Road Bonus Telegram Group ID"
        help="One summary posted when a company driver comes home after exceeding the road-week allowance (total extra weeks + total bonus)."
        placeholder="e.g. -1001234567890"
        value={form.roadBonus}
        onChange={(v) => setField("roadBonus", v)}
        status={settings?.roadBonus}
      />
      <GroupIdField
        label="72–75 CPM / Dispatch Rate Review Telegram Group ID"
        help="The weekly request asking dispatch to mark which drivers qualify for 72–75¢/mile, plus each team's submitted result summary."
        placeholder="e.g. -1001234567890"
        value={form.dispatchReview}
        onChange={(v) => setField("dispatchReview", v)}
        status={settings?.dispatchReview}
      />

      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save settings"}</button>
        {settings?.updatedAt && <span style={{ fontSize: 12, color: "#94a3b8" }}>Last updated {new Date(settings.updatedAt).toLocaleString()}</span>}
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
        <button className={`btn ${tab === "groups" ? "btn-primary" : "btn-ghost"} touch-target`} onClick={() => setTab("groups")}>💬 Telegram Groups</button>
      </div>
      {tab === "location" && <LocationProvidersTab />}
      {tab === "ringcentral" && <RingCentralTab />}
      {tab === "groups" && <TelegramGroupsTab />}
    </div>
  );
}
