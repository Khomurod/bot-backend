import React, { useCallback, useEffect, useState } from "react";
import * as api from "../../api";
import { NumField, Banner } from "./fields";

// ─────────────────────────── BOL/POD Monitor tab ─────────────────────────────

function ToggleRow({ label, hint, checked, onChange }) {
  return (
    <label style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "8px 0", cursor: "pointer" }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ marginTop: 3 }} />
      <span>
        <span style={{ fontWeight: 600 }}>{label}</span>
        {hint && <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 2 }}>{hint}</div>}
      </span>
    </label>
  );
}

function StatusLine({ label, ok, text }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: 13 }}>
      <span style={{ color: "#94a3b8" }}>{label}</span>
      <span className={`badge ${ok === true ? "badge-active" : ok === false ? "badge-inactive" : "badge-muted"}`}>{text}</span>
    </div>
  );
}

export default function BolPodMonitorTab() {
  const DEFAULT_GROUP = "-5289094495";
  const [settings, setSettings] = useState(null);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [form, setForm] = useState({
    enabled: false,
    testGroupId: DEFAULT_GROUP,
    sendUnrelated: true,
    sendUnclear: true,
    sendFiles: true,
  });
  const setField = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, st] = await Promise.all([
        api.getBolPodMonitorSettings(),
        api.getBolPodMonitorStatus().catch(() => null),
      ]);
      setSettings(s);
      setStatus(st);
      setForm({
        enabled: !!s.enabled,
        testGroupId: s.testGroupId || DEFAULT_GROUP,
        sendUnrelated: !!s.sendUnrelated,
        sendUnclear: !!s.sendUnclear,
        sendFiles: !!s.sendFiles,
      });
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const payload = {
        test_monitor_enabled: !!form.enabled,
        test_group_id: String(form.testGroupId || "").trim(),
        test_send_unrelated: !!form.sendUnrelated,
        test_send_unclear: !!form.sendUnclear,
        test_send_files: !!form.sendFiles,
      };
      const s = await api.updateBolPodMonitorSettings(payload);
      setSettings(s);
      setMessage({ type: "success", text: "BOL/POD monitor settings saved." });
      api.getBolPodMonitorStatus().then(setStatus).catch(() => {});
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await api.sendBolPodMonitorTestMessage(String(form.testGroupId || "").trim() || undefined));
    } catch (err) {
      setTestResult({ ok: false, error: err.message });
    } finally {
      setTesting(false);
    }
  };

  const checkAccess = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api.checkBolPodMonitorAccess(String(form.testGroupId || "").trim() || undefined);
      setTestResult(r.ok
        ? { ok: true, message: `Bot can access group${r.title ? ` "${r.title}"` : ""} (${r.type || "chat"}).` }
        : r);
    } catch (err) {
      setTestResult({ ok: false, error: err.message });
    } finally {
      setTesting(false);
    }
  };

  if (loading) return <div className="loading"><div className="spinner"></div> Loading…</div>;

  const groupMissing = !String(form.testGroupId || "").trim();

  return (
    <div>
      <div className="page-header">
        <h3>📦 BOL/POD Monitor (silent test)</h3>
        <p>
          Silently watch active driver groups, classify BOL/POD documents, match the load, and send a
          diagnostic report (and optionally the files) to a <strong>test Telegram group only</strong>.
          Driver groups receive <strong>no messages</strong> and <strong>nothing is uploaded to Datatruck</strong>.
          Controlled here — no Render environment variables required. Changes take effect within ~15 seconds; no redeploy needed.
        </p>
      </div>

      <Banner message={message} />

      {form.enabled && (
        <div className="alert alert-warning">
          Silent monitor is <strong>ON</strong>. Driver groups will not receive replies or buttons.
          Reports are sent only to the configured test group. No Datatruck upload happens.
        </div>
      )}
      {groupMissing && (
        <div className="alert alert-warning">Set a test Telegram group ID before enabling the monitor.</div>
      )}

      <div className="card">
        <ToggleRow
          label="Enable silent BOL/POD test monitor"
          hint="When on, the bot watches driver groups and posts detection reports to the test group only."
          checked={form.enabled}
          onChange={(v) => setField("enabled", v)}
        />

        <div className="form-group" style={{ marginTop: 12 }}>
          <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>
            Test Telegram group ID — <span style={{ color: "#94a3b8", fontWeight: 400 }}>Automatic updating (Test) group</span>
          </label>
          <input
            className="form-input"
            style={{ maxWidth: 320, fontFamily: "monospace" }}
            value={form.testGroupId}
            placeholder={DEFAULT_GROUP}
            onChange={(e) => setField("testGroupId", e.target.value)}
          />
          <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>
            Default: <code>{DEFAULT_GROUP}</code>. The bot must be a member of this group.
          </div>
        </div>

        <div style={{ marginTop: 8 }}>
          <ToggleRow label="Send unrelated files to test group" hint="Report documents the AI classifies as unrelated (fuel receipts, etc.)." checked={form.sendUnrelated} onChange={(v) => setField("sendUnrelated", v)} />
          <ToggleRow label="Send unclear files to test group" hint="Report documents the AI could not confidently classify." checked={form.sendUnclear} onChange={(v) => setField("sendUnclear", v)} />
          <ToggleRow label="Send / attach files to test group" hint="Attach the detected file(s) (merged into one PDF when there are several)." checked={form.sendFiles} onChange={(v) => setField("sendFiles", v)} />
        </div>

        <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 16, flexWrap: "wrap" }}>
          <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save settings"}</button>
          <button className="btn btn-ghost btn-sm" onClick={sendTest} disabled={testing}>{testing ? "Working…" : "Send test message"}</button>
          <button className="btn btn-ghost btn-sm" onClick={checkAccess} disabled={testing}>Check bot access</button>
          {settings?.updatedAt && <span style={{ fontSize: 12, color: "#94a3b8" }}>Last saved {new Date(settings.updatedAt).toLocaleString()}{settings.updatedBy ? ` by ${settings.updatedBy}` : ""}</span>}
        </div>

        {testResult && (
          <div className={`alert alert-${testResult.ok ? "success" : "error"}`} style={{ marginTop: 12 }}>
            {testResult.ok
              ? (testResult.message || `Test message sent${testResult.chatId ? ` to ${testResult.chatId}` : ""}.`)
              : (testResult.error || "Bot cannot send to this test group. Add the bot to the group or check the group ID.")}
          </div>
        )}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h4 style={{ marginTop: 0 }}>Status</h4>
        <StatusLine label="Monitor" ok={!!settings?.enabled} text={settings?.enabled ? "Enabled" : "Disabled"} />
        <StatusLine label="Test group ID" ok={!groupMissing} text={settings?.testGroupId || "not set"} />
        <StatusLine label="AI classifier" ok={!!status?.aiClassifierConfigured} text={status?.aiClassifierConfigured ? "Configured" : "Not configured"} />
        <StatusLine label="Datatruck API" ok={!!status?.datatruckConfigured} text={status?.datatruckConfigured ? "Configured" : "Not configured"} />
        <StatusLine label="Upload pipeline" ok={status ? status.uploadMode !== "live" : null} text={status ? (status.uploadMode === "off" ? "Off" : status.uploadMode === "dry_run" ? "Dry-run" : "LIVE") : "unknown"} />
        <StatusLine label="Reports sent" ok={null} text={String(settings?.reportCount ?? 0)} />
        <StatusLine label="Last report" ok={null} text={settings?.lastReportAt ? new Date(settings.lastReportAt).toLocaleString() : "never"} />
        <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 8 }}>
          The silent monitor never uploads to Datatruck — it only reports to the test group. The upload
          pipeline (separate) stays {status?.uploadMode === "off" ? "off" : status?.uploadMode === "live" ? "LIVE" : "in dry-run"} and is unaffected by these settings.
        </div>
      </div>
    </div>
  );
}
