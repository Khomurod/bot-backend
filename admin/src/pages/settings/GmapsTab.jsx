import React, { useCallback, useEffect, useState } from "react";
import * as api from "../../api";
import { KeyField, NumField, Banner } from "./fields";

// ─────────────────────────────── GMaps tab ───────────────────────────────────

export default function GmapsTab() {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [test, setTest] = useState(null);
  const [testing, setTesting] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [form, setForm] = useState({
    enabled: false, serverApiKey: "", routesApiEnabled: true, roadsApiEnabled: false,
    geocodingApiEnabled: false, geocodingApiKey: "",
    deviationThresholdMeters: 250, checkIntervalSeconds: 300, offRouteGraceChecks: 3,
    warningCooldownMinutes: 30, staleGpsMinutes: 15, parkedSpeedMph: 5,
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const s = await api.getGmapsSettings();
      setSettings(s);
      setForm((f) => ({
        ...f, enabled: s.enabled, routesApiEnabled: s.routesApiEnabled, roadsApiEnabled: s.roadsApiEnabled,
        geocodingApiEnabled: s.geocodingApiEnabled,
        deviationThresholdMeters: s.deviationThresholdMeters, checkIntervalSeconds: s.checkIntervalSeconds,
        offRouteGraceChecks: s.offRouteGraceChecks, warningCooldownMinutes: s.warningCooldownMinutes,
        staleGpsMinutes: s.staleGpsMinutes, parkedSpeedMph: s.parkedSpeedMph,
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
        enabled: form.enabled, routesApiEnabled: form.routesApiEnabled, roadsApiEnabled: form.roadsApiEnabled,
        geocodingApiEnabled: form.geocodingApiEnabled,
        deviationThresholdMeters: Number(form.deviationThresholdMeters),
        checkIntervalSeconds: Number(form.checkIntervalSeconds),
        offRouteGraceChecks: Number(form.offRouteGraceChecks),
        warningCooldownMinutes: Number(form.warningCooldownMinutes),
        staleGpsMinutes: Number(form.staleGpsMinutes), parkedSpeedMph: Number(form.parkedSpeedMph),
      };
      if (form.serverApiKey.trim()) payload.serverApiKey = form.serverApiKey.trim();
      if (form.geocodingApiKey.trim()) payload.geocodingApiKey = form.geocodingApiKey.trim();
      const s = await api.updateGmapsSettings(payload);
      setSettings(s);
      setForm((f) => ({ ...f, serverApiKey: "", geocodingApiKey: "" }));
      setMessage({ type: "success", text: "Google Maps settings saved." });
    } catch (err) { setMessage({ type: "error", text: err.message }); }
    finally { setSaving(false); }
  };

  const runTest = async () => {
    setTesting(true); setTest(null);
    try { setTest(await api.testGmapsConnection(form.serverApiKey.trim() || undefined)); }
    catch (err) { setTest({ connected: false, message: err.message }); }
    finally { setTesting(false); }
  };

  if (loading) return <div className="loading"><div className="spinner"></div> Loading…</div>;

  return (
    <div>
      <p style={{ color: "#94a3b8", marginTop: 0 }}>
        Google Maps Platform powers <strong>Route Control</strong> — assigning a driver a planned route and
        warning their group if they drift off it. The server API key is stored encrypted and never shown again
        after saving. The feature stays off until you enable it and enter a key below.
      </p>
      <Banner message={message} />

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>🗺️ Google Maps Platform</h3>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14 }}>
            <input type="checkbox" checked={form.enabled} onChange={(e) => setField("enabled", e.target.checked)} /> Enabled
          </label>
        </div>
        <KeyField label="Server API Key" hint={settings.serverApiKeySet ? settings.serverApiKeyMasked : "not set"} fromEnv={settings.serverApiKeyFromEnv} value={form.serverApiKey} onChange={(v) => setField("serverApiKey", v)} />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginTop: 8 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
            <input type="checkbox" checked={form.routesApiEnabled} onChange={(e) => setField("routesApiEnabled", e.target.checked)} /> Routes API
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
            <input type="checkbox" checked={form.roadsApiEnabled} onChange={(e) => setField("roadsApiEnabled", e.target.checked)} /> Roads API (GPS snap)
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
            <input type="checkbox" checked={form.geocodingApiEnabled} onChange={(e) => setField("geocodingApiEnabled", e.target.checked)} /> Geocoding API
          </label>
        </div>
        {form.geocodingApiEnabled && (
          <div style={{ marginTop: 8 }}>
            <KeyField label="Geocoding API Key (optional — falls back to the server key)" hint={settings.geocodingApiKeySet ? settings.geocodingApiKeyMasked : "uses server key"} value={form.geocodingApiKey} onChange={(v) => setField("geocodingApiKey", v)} />
          </div>
        )}
        <div style={{ marginTop: 10 }}>
          <button className="btn btn-ghost btn-sm" onClick={runTest} disabled={testing}>{testing ? "Testing…" : "Test Connection"}</button>
          {test && <span className={`badge ${test.connected ? "badge-active" : "badge-inactive"}`} style={{ marginLeft: 8 }}>{test.connected ? "✓ Connected" : "✕ Not connected"}</span>}
          {test?.message && <div style={{ fontSize: 12, color: test.connected ? "#22c55e" : "#f87171", marginTop: 4 }}>{test.message}</div>}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>🚧 Off-route detection</h3>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 24 }}>
          <div>
            <NumField label="Deviation threshold" value={form.deviationThresholdMeters} onChange={(v) => setField("deviationThresholdMeters", v)} suffix="meters" />
            <NumField label="Check interval" value={form.checkIntervalSeconds} onChange={(v) => setField("checkIntervalSeconds", v)} suffix="seconds" />
          </div>
          <div>
            <NumField label="Off-route grace" value={form.offRouteGraceChecks} onChange={(v) => setField("offRouteGraceChecks", v)} suffix="consecutive checks" />
            <NumField label="Warning cooldown" value={form.warningCooldownMinutes} onChange={(v) => setField("warningCooldownMinutes", v)} suffix="minutes" />
          </div>
          <div>
            <NumField label="Stale GPS after" value={form.staleGpsMinutes} onChange={(v) => setField("staleGpsMinutes", v)} suffix="minutes" />
            <NumField label="Parked at/below" value={form.parkedSpeedMph} onChange={(v) => setField("parkedSpeedMph", v)} suffix="mph" />
          </div>
        </div>
        <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>
          A driver must be off route by more than the threshold for the grace number of consecutive checks before a warning
          is sent. Warnings are then spaced by the cooldown. Stale GPS and parked/slow trucks never trigger a warning.
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <button className="btn btn-ghost btn-sm" onClick={() => setShowHelp((v) => !v)}>{showHelp ? "▾" : "▸"} How to set this up</button>
        {showHelp && (
          <ol style={{ fontSize: 13, color: "#cbd5e1", lineHeight: 1.7, marginTop: 10 }}>
            <li>Open the <strong>Google Cloud Console</strong> (console.cloud.google.com).</li>
            <li>Create or select a <strong>project</strong>.</li>
            <li>Enable <strong>billing</strong> for that project (required for the Maps APIs).</li>
            <li>Enable the <strong>Routes API</strong>.</li>
            <li>Optionally enable the <strong>Roads API</strong> (GPS snap-to-roads) and <strong>Geocoding API</strong>.</li>
            <li>Go to <strong>APIs &amp; Services → Credentials</strong> and <strong>create an API key</strong>.</li>
            <li><strong>Restrict the key</strong> to only the APIs you enabled above.</li>
            <li>If you have a fixed server IP, add an <strong>IP restriction</strong> for that server (recommended).</li>
            <li>Paste the key into <strong>Server API Key</strong> above and tick <strong>Enabled</strong>.</li>
            <li>Click <strong>Test Connection</strong> to confirm it works, then <strong>Save</strong>.</li>
          </ol>
        )}
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save settings"}</button>
        {settings.updatedAt && <span style={{ fontSize: 12, color: "#94a3b8" }}>Last updated {new Date(settings.updatedAt).toLocaleString()}</span>}
      </div>
    </div>
  );
}
