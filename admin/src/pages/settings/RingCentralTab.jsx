import React, { useCallback, useEffect, useState } from "react";
import * as api from "../../api";
import { KeyField, NumField, Banner } from "./fields";
import RecruiterCard from "./ringcentral/RecruiterCard";
import BitrixCard from "./ringcentral/BitrixCard";

// ─────────────────────────────── RingCentral tab ─────────────────────────────
//
// Two things are configured here, and they are not the same thing:
//   • the SHARED app credentials (Client ID/Secret) every number authenticates
//     with, plus the KPI targets — the cards below;
//   • each recruiter's OWN identity: their number, their RingCentral sign-in,
//     and which Bitrix24 user they are. That mapping is what makes a Facebook
//     lead go out from the assigned recruiter's number instead of the shared
//     company line, so a recruiter with no sign-in or no Bitrix id is shown as
//     such on their row rather than looking configured.

export default function RingCentralTab() {
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
    targetTalkMinutes: 150, targetOutbound: 150, targetRealConversations: 35,
  });
  const [newRec, setNewRec] = useState({ name: "", phoneNumber: "", bitrixUserId: "", jwtToken: "", clientId: "", clientSecret: "", useCustom: false });
  const [inviteName, setInviteName] = useState("");
  const [inviteUrl, setInviteUrl] = useState(null);

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
        targetTalkMinutes: s.targetTalkMinutes ?? 150,
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
        targetTalkMinutes: Number(form.targetTalkMinutes),
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
      if (newRec.bitrixUserId.trim()) payload.bitrixUserId = newRec.bitrixUserId.trim();
      if (newRec.jwtToken.trim()) payload.jwtToken = newRec.jwtToken.trim();
      if (newRec.useCustom) {
        if (newRec.clientId.trim()) payload.clientId = newRec.clientId.trim();
        if (newRec.clientSecret.trim()) payload.clientSecret = newRec.clientSecret.trim();
      }
      await api.createRecruiter(payload);
      setNewRec({ name: "", phoneNumber: "", bitrixUserId: "", jwtToken: "", clientId: "", clientSecret: "", useCustom: false });
      await refreshRecruiters();
      setMessage({ type: "success", text: "Recruiter added. Use Test connection / Diagnose on the row to verify." });
    } catch (err) { setMessage({ type: "error", text: err.message }); }
  };

  const inviteNewRecruiter = async () => {
    try {
      const { connectUrl } = await api.createRecruiterConnectLink({ invitedName: inviteName.trim() || undefined });
      setInviteUrl(connectUrl);
      setMessage(null);
    } catch (err) { setMessage({ type: "error", text: err.message }); }
  };

  if (loading) return <div className="loading"><div className="spinner"></div> Loading…</div>;

  return (
    <div>
      <p style={{ color: "#94a3b8", marginTop: 0 }}>
        RingCentral powers two things: recruiter call KPIs (the bot reads each recruiter's call
        log and scores it against the daily targets) and <strong>who texts a lead</strong> — a
        Facebook lead is texted from the number of whoever Bitrix24 assigned it to.
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
        <p style={{ fontSize: 13, color: "#94a3b8", marginTop: 0 }}>
          Main KPI: <strong>2.5h real call duration</strong> per recruiter per day — calls under 30
          seconds do not count. Secondary KPI: <strong>150 outbound calls</strong> per day.
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 24 }}>
          <div>
            <NumField label="Real talk-time target (main KPI)" value={form.targetTalkMinutes} onChange={(v) => setField("targetTalkMinutes", v)} suffix="minutes/day" />
            <NumField label="Total Outbound target (secondary)" value={form.targetOutbound} onChange={(v) => setField("targetOutbound", v)} suffix="calls/day" />
            <NumField label="Real Conversations target" value={form.targetRealConversations} onChange={(v) => setField("targetRealConversations", v)} suffix="calls/day" />
          </div>
          <div>
            <NumField label="Minimum call duration counted toward talk time" value={form.nonValuableMaxSeconds} onChange={(v) => setField("nonValuableMaxSeconds", v)} suffix="seconds" />
            <div style={{ fontSize: 12, color: "#94a3b8", marginTop: -6, marginBottom: 10, maxWidth: 320 }}>
              Calls shorter than this threshold do not count toward real talk time. Default: 30 seconds.
            </div>
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

      <BitrixCard onMessage={setMessage} />

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>🔗 Invite A Recruiter To Connect RingCentral</h3>
        <p style={{ fontSize: 13, color: "#94a3b8", marginTop: 0 }}>
          The easy way to add someone: send them a link, they sign in to RingCentral as
          themselves, and their number and extension are read from their account — nobody
          has to generate or paste a JWT. If the number is not on the platform yet, the
          recruiter row is created from it.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-start" }}>
          <input
            className="form-input"
            style={{ maxWidth: 260 }}
            placeholder="Their name (optional)"
            value={inviteName}
            onChange={(e) => setInviteName(e.target.value)}
          />
          <button className="btn btn-primary btn-sm" onClick={inviteNewRecruiter}>Create sign-in link</button>
        </div>
        {inviteUrl && (
          <div style={{ marginTop: 10, padding: 10, borderRadius: 8, background: "rgba(34,197,94,0.1)" }}>
            <div style={{ fontSize: 12, color: "#cbd5e1", marginBottom: 4 }}>
              Send this link to the recruiter. It expires in 30 minutes and works once.
            </div>
            <input className="form-input" readOnly value={inviteUrl} onFocus={(e) => e.target.select()} />
          </div>
        )}
        <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 10 }}>
          After they connect, set their <strong>Bitrix24 user ID</strong> on their row below —
          that is what matches an assigned lead to their number.
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>➕ Add Recruiter &amp; Number Manually</h3>
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
          <div className="form-group" style={{ marginBottom: 8 }}>
            <label style={{ display: "block", fontSize: 12, marginBottom: 4 }}>Bitrix24 user ID</label>
            <input className="form-input" inputMode="numeric" placeholder="e.g. 17" value={newRec.bitrixUserId} onChange={(e) => setNewRec((n) => ({ ...n, bitrixUserId: e.target.value }))} />
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
          A row that says <strong>Sends as self</strong> and carries a <strong>Bitrix #</strong> will
          text its own leads. Anything else falls back to the shared company number. Use
          <strong> Test connection</strong> for a quick check, <strong>Diagnose</strong> for a
          step-by-step report (credentials → auth → number match → SMS capability → call log),
          or <strong>Send test SMS</strong> on the row to prove it end to end.
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
