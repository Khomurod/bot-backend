import React, { Suspense, lazy, useCallback, useEffect, useState } from "react";
import * as api from "../../api";
import { Banner, NumField } from "./fields";
import { ConnectionCard } from "./samsara/ConnectionCard";
import { VideoRecoveryCard } from "./samsara/VideoRecoveryCard";

const SafetyEventsTab = lazy(() => import("./SafetyEventsTab"));

/**
 * SAMSARA — one integration, one settings area.
 *
 * It replaced a split where the API key lived under Live Location, the music
 * overlay under "Safety Event Music", and everything about missing-video
 * recovery lived in Render environment variables on a service the admin does
 * not deploy. Connection, safety-event behaviour and video recovery are one
 * settings row here, read by BOTH this app and the separate Samsara poller over
 * the shared database.
 *
 * The music overlay keeps its own component and its own endpoints — it is
 * rendered below as a section rather than rewritten, so nothing about the
 * uploaded clips, volume, fades or the driver-group behaviour changes.
 */
export default function SamsaraTab() {
  const [settings, setSettings] = useState(null);
  const [recovery, setRecovery] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [form, setForm] = useState(null);

  const applySettings = useCallback((next) => {
    setSettings(next);
    setForm({
      enabled: next.enabled,
      // Always blank: the key is write-only, and a blank box means "keep the
      // key that is already working".
      apiKey: "",
      apiBase: next.apiBase || "",
      speedingEventsEnabled: next.speedingEventsEnabled,
      maxVideoMegabytes: next.maxVideoMegabytes,
      videoRecoveryEnabled: next.videoRecoveryEnabled,
      videoRecoveryInitialDelaySeconds: next.videoRecoveryInitialDelaySeconds,
      videoRetrievalEnabled: next.videoRetrievalEnabled,
      videoRecoveryRetryIntervalSeconds: next.videoRecoveryRetryIntervalSeconds,
      videoRecoveryMaxAttempts: next.videoRecoveryMaxAttempts,
      videoRetrievalWindowBeforeSeconds: next.videoRetrievalWindowBeforeSeconds,
      videoRetrievalWindowAfterSeconds: next.videoRetrievalWindowAfterSeconds,
    });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getSamsaraSettings();
      applySettings(data.settings);
      setRecovery(data.recovery);
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally { setLoading(false); }
  }, [applySettings]);
  useEffect(() => { load(); }, [load]);

  const setField = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  const save = async () => {
    setSaving(true); setMessage(null);
    try {
      const payload = {
        enabled: form.enabled,
        apiBase: form.apiBase,
        speedingEventsEnabled: form.speedingEventsEnabled,
        maxVideoMegabytes: Number(form.maxVideoMegabytes),
        videoRecoveryEnabled: form.videoRecoveryEnabled,
        videoRecoveryInitialDelaySeconds: Number(form.videoRecoveryInitialDelaySeconds),
        videoRetrievalEnabled: form.videoRetrievalEnabled,
        videoRecoveryRetryIntervalSeconds: Number(form.videoRecoveryRetryIntervalSeconds),
        videoRecoveryMaxAttempts: Number(form.videoRecoveryMaxAttempts),
        videoRetrievalWindowBeforeSeconds: Number(form.videoRetrievalWindowBeforeSeconds),
        videoRetrievalWindowAfterSeconds: Number(form.videoRetrievalWindowAfterSeconds),
      };
      // Only send a key when one was typed — an omitted field leaves the stored
      // credential alone, which is what stops a routine save wiping it.
      if (form.apiKey?.trim()) payload.apiKey = form.apiKey.trim();

      applySettings(await api.updateSamsaraSettings(payload));
      setMessage({ type: "success", text: "Samsara settings saved." });
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally { setSaving(false); }
  };

  if (loading || !form) return <div className="loading"><div className="spinner"></div> Loading…</div>;

  return (
    <div>
      <p style={{ color: "#94a3b8", marginTop: 0 }}>
        Samsara safety events are polled by a separate service that reads these settings from
        the shared database. Changes here reach it within a minute — no redeploy.
      </p>
      <Banner message={message} />

      <ConnectionCard settings={settings} form={form} setField={setField} onSaved={applySettings} />

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>🚨 Safety events</h3>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14, marginBottom: 10 }}>
          <input
            type="checkbox"
            checked={form.speedingEventsEnabled}
            onChange={(e) => setField("speedingEventsEnabled", e.target.checked)}
          /> Poll speeding events
        </label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 24 }}>
          <NumField
            label="Largest clip to download"
            value={form.maxVideoMegabytes}
            onChange={(v) => setField("maxVideoMegabytes", v)}
            suffix="MB"
          />
        </div>
      </div>

      <VideoRecoveryCard form={form} setField={setField} recovery={recovery} />

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 24 }}>
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save Samsara settings"}
        </button>
        {settings?.updatedAt && (
          <span style={{ fontSize: 12, color: "#94a3b8" }}>
            Last updated {new Date(settings.updatedAt).toLocaleString()}
            {settings.updatedBy ? ` by ${settings.updatedBy}` : ""}
          </span>
        )}
      </div>

      <h3 style={{ borderTop: "1px solid rgba(148,163,184,0.2)", paddingTop: 16 }}>
        🎵 Safety-event video &amp; music
      </h3>
      <Suspense fallback={<div style={{ padding: 12, color: "#94a3b8" }}>Loading…</div>}>
        <SafetyEventsTab />
      </Suspense>
    </div>
  );
}
