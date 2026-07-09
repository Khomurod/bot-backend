import React, { useCallback, useEffect, useState } from "react";
import * as api from "../../api";
import { NumField, Banner } from "./fields";


// ──────────────────────── Safety-event music overlay tab ─────────────────────

function fmtDuration(seconds) {
  if (seconds == null) return "unknown";
  const s = Math.round(Number(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

function fmtBytes(bytes) {
  if (!bytes) return "0 B";
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(2)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

export default function SafetyEventsTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState(null);
  const [file, setFile] = useState(null);
  const [name, setName] = useState("");
  const [status, setStatus] = useState(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [form, setForm] = useState({
    driverGroupMusicEnabled: false, speedingMusicEnabled: true, preserveOriginalAudio: true,
    loopMusicWhenVideoLonger: true, musicVolume: 0.35, fadeInSeconds: 0, fadeOutSeconds: 1.5,
    maxVideoSeconds: 120,
  });

  const applyView = useCallback((view) => {
    setData(view);
    const s = view.settings || {};
    setForm((f) => ({
      ...f,
      driverGroupMusicEnabled: s.driverGroupMusicEnabled,
      speedingMusicEnabled: s.speedingMusicEnabled,
      preserveOriginalAudio: s.preserveOriginalAudio,
      loopMusicWhenVideoLonger: s.loopMusicWhenVideoLonger,
      musicVolume: s.musicVolume, fadeInSeconds: s.fadeInSeconds,
      fadeOutSeconds: s.fadeOutSeconds, maxVideoSeconds: s.maxVideoSeconds,
    }));
  }, []);

  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    try { setStatus(await api.getSafetyEventStatus()); }
    catch { /* diagnostics are best-effort; ignore */ }
    finally { setStatusLoading(false); }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try { applyView(await api.getSafetyEventSettings()); }
    catch (err) { setMessage({ type: "error", text: err.message }); }
    finally { setLoading(false); }
  }, [applyView]);
  useEffect(() => { load(); loadStatus(); }, [load, loadStatus]);

  const setField = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setSaving(true); setMessage(null);
    try {
      const view = await api.updateSafetyEventSettings({
        driverGroupMusicEnabled: form.driverGroupMusicEnabled,
        speedingMusicEnabled: form.speedingMusicEnabled,
        preserveOriginalAudio: form.preserveOriginalAudio,
        loopMusicWhenVideoLonger: form.loopMusicWhenVideoLonger,
        musicVolume: Number(form.musicVolume),
        fadeInSeconds: Number(form.fadeInSeconds),
        fadeOutSeconds: Number(form.fadeOutSeconds),
        maxVideoSeconds: Number(form.maxVideoSeconds),
      });
      applyView(view);
      setMessage({ type: "success", text: "Safety-event music settings saved." });
    } catch (err) { setMessage({ type: "error", text: err.message }); }
    finally { setSaving(false); }
  };

  const upload = async () => {
    if (!file) { setMessage({ type: "error", text: "Choose an audio file first." }); return; }
    setUploading(true); setMessage(null);
    try {
      const view = await api.uploadSafetyEventMusic(file, { name: name.trim() || undefined });
      applyView(view);
      setFile(null); setName("");
      setMessage({ type: "success", text: "Music uploaded and set active." });
    } catch (err) { setMessage({ type: "error", text: err.message }); }
    finally { setUploading(false); }
  };

  const doAction = async (fn) => {
    setMessage(null);
    try { applyView(await fn()); }
    catch (err) { setMessage({ type: "error", text: err.message }); }
  };

  if (loading) return <div className="loading"><div className="spinner"></div> Loading…</div>;

  const assets = data?.musicAssets || [];
  const active = data?.activeMusic || null;

  return (
    <div>
      <p style={{ color: "#94a3b8", marginTop: 0 }}>
        Embed background music into the <strong>driver-group</strong> copy of a speeding-event dashcam video.
        The <strong>Samsara notifications group always receives the original video immediately and unchanged</strong> —
        music is only added to the driver group's copy, and if processing fails the driver group still gets the original.
      </p>
      <Banner message={message} />

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>🎵 Active music</h3>
        {active ? (
          <div style={{ fontSize: 14 }}>
            <strong>{active.name}</strong>{" "}
            <span className="badge badge-active" style={{ marginLeft: 6 }}>active</span>
            <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>
              {active.mimeType} · {fmtDuration(active.durationSeconds)} · {fmtBytes(active.fileSizeBytes)}
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 13, color: "#f59e0b" }}>
            No active music — the overlay is effectively disabled until you upload/select a clip.
          </div>
        )}
        <div style={{ marginTop: 12, borderTop: "1px solid rgba(148,163,184,0.2)", paddingTop: 12 }}>
          <label style={{ display: "block", fontWeight: 600, marginBottom: 4, fontSize: 13 }}>Upload music (mp3, wav, m4a, aac — max 20 MB)</label>
          <input type="file" accept="audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a,audio/aac"
            onChange={(e) => setFile(e.target.files?.[0] || null)} />
          <input className="form-input" style={{ maxWidth: 280, marginTop: 8 }} placeholder="Optional display name"
            value={name} onChange={(e) => setName(e.target.value)} />
          <div style={{ marginTop: 8 }}>
            <button className="btn btn-primary btn-sm" onClick={upload} disabled={uploading || !file}>
              {uploading ? "Uploading…" : "Upload & activate"}
            </button>
          </div>
        </div>
      </div>

      {assets.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginTop: 0 }}>Uploaded clips</h3>
          <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
            <tbody>
              {assets.map((a) => (
                <tr key={a.id} style={{ borderTop: "1px solid rgba(148,163,184,0.15)" }}>
                  <td style={{ padding: "8px 6px" }}>
                    {a.name}{a.isActive && <span className="badge badge-active" style={{ marginLeft: 6 }}>active</span>}
                    <div style={{ fontSize: 11, color: "#94a3b8" }}>{fmtDuration(a.durationSeconds)} · {fmtBytes(a.fileSizeBytes)}</div>
                  </td>
                  <td style={{ padding: "8px 6px", textAlign: "right", whiteSpace: "nowrap" }}>
                    {!a.isActive && <button className="btn btn-ghost btn-sm" onClick={() => doAction(() => api.activateSafetyEventMusic(a.id))}>Activate</button>}
                    {a.isActive && <button className="btn btn-ghost btn-sm" onClick={() => doAction(() => api.deactivateSafetyEventMusic(a.id))}>Deactivate</button>}
                    {!a.isActive && <button className="btn btn-ghost btn-sm" style={{ color: "#f87171" }} onClick={() => doAction(() => api.deleteSafetyEventMusic(a.id))}>Delete</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>Overlay behaviour</h3>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginBottom: 10 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14 }}>
            <input type="checkbox" checked={form.driverGroupMusicEnabled} onChange={(e) => setField("driverGroupMusicEnabled", e.target.checked)} /> Enable driver-group music overlay
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14 }}>
            <input type="checkbox" checked={form.speedingMusicEnabled} onChange={(e) => setField("speedingMusicEnabled", e.target.checked)} /> Apply to speeding events
          </label>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginBottom: 10 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
            <input type="checkbox" checked={form.preserveOriginalAudio} onChange={(e) => setField("preserveOriginalAudio", e.target.checked)} /> Keep original audio (mix music underneath)
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
            <input type="checkbox" checked={form.loopMusicWhenVideoLonger} onChange={(e) => setField("loopMusicWhenVideoLonger", e.target.checked)} /> Loop music if video is longer
          </label>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 24 }}>
          <NumField label="Music volume (0–2)" value={form.musicVolume} onChange={(v) => setField("musicVolume", v)} suffix="×" />
          <NumField label="Fade in" value={form.fadeInSeconds} onChange={(v) => setField("fadeInSeconds", v)} suffix="seconds" />
          <NumField label="Fade out" value={form.fadeOutSeconds} onChange={(v) => setField("fadeOutSeconds", v)} suffix="seconds" />
          <NumField label="Max video length to process" value={form.maxVideoSeconds} onChange={(v) => setField("maxVideoSeconds", v)} suffix="seconds (0 = no cap)" />
        </div>
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save settings"}</button>
        {data?.settings?.updatedAt && <span style={{ fontSize: 12, color: "#94a3b8" }}>Last updated {new Date(data.settings.updatedAt).toLocaleString()}</span>}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ margin: 0 }}>🩺 Overlay diagnostics</h3>
          <button className="btn btn-ghost btn-sm" onClick={loadStatus} disabled={statusLoading}>{statusLoading ? "Refreshing…" : "Refresh"}</button>
        </div>
        <p style={{ fontSize: 12, color: "#94a3b8", marginTop: 6 }}>
          The overlay itself runs in the separate <strong>samsara-integration</strong> service. These rows come from the
          shared <code>safety_event_video_jobs</code> ledger — use them to see whether overlay is happening and why a
          clip fell back to the original. <strong>ffmpeg availability is only known to that service</strong> (check its
          startup logs for the <code>[SafetyVideo] Readiness</code> lines).
        </p>
        {status ? (
          <>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 13, marginBottom: 10 }}>
              <span className={`badge ${status.overlayConfigured ? "badge-active" : "badge-inactive"}`}>
                {status.overlayConfigured ? "Configured (enabled + active music)" : "Not fully configured"}
              </span>
              <span className={`badge ${status.activeMusicPresent ? "badge-active" : "badge-inactive"}`}>
                {status.activeMusicPresent ? "Active music present" : "No active music"}
              </span>
              {Object.entries(status.jobStatusCounts || {}).map(([k, v]) => (
                <span key={k} className="badge badge-muted">{k}: {v}</span>
              ))}
            </div>
            {status.lastFailure && (
              <div className="alert alert-warning" style={{ fontSize: 12 }}>
                Last fallback/failure ({status.lastFailure.status}{status.lastFailure.source ? `, ${status.lastFailure.source}` : ""})
                {status.lastFailure.at ? ` at ${new Date(status.lastFailure.at).toLocaleString()}` : ""}
                {status.lastFailure.reason ? `: ${status.lastFailure.reason}` : ""}
              </div>
            )}
            {status.recentJobs?.length ? (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse", minWidth: 520 }}>
                  <thead>
                    <tr style={{ textAlign: "left", color: "#94a3b8" }}>
                      <th style={{ padding: "4px 6px" }}>When</th>
                      <th style={{ padding: "4px 6px" }}>Status</th>
                      <th style={{ padding: "4px 6px" }}>Source</th>
                      <th style={{ padding: "4px 6px" }}>Trim</th>
                      <th style={{ padding: "4px 6px" }}>Video</th>
                      <th style={{ padding: "4px 6px" }}>Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {status.recentJobs.map((j) => (
                      <tr key={j.id} style={{ borderTop: "1px solid rgba(148,163,184,0.15)" }}>
                        <td style={{ padding: "4px 6px", whiteSpace: "nowrap" }}>{j.created_at ? new Date(j.created_at).toLocaleString() : "—"}</td>
                        <td style={{ padding: "4px 6px" }}>{j.status}</td>
                        <td style={{ padding: "4px 6px" }}>{j.video_source || "—"}</td>
                        <td style={{ padding: "4px 6px" }}>{j.music_trim_mode || "—"}</td>
                        <td style={{ padding: "4px 6px" }}>{fmtDuration(j.video_duration_seconds)}</td>
                        <td style={{ padding: "4px 6px", color: "#94a3b8" }}>{j.error_message || ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div style={{ fontSize: 13, color: "#94a3b8" }}>No overlay jobs recorded yet.</div>
            )}
          </>
        ) : (
          <div style={{ fontSize: 13, color: "#94a3b8" }}>{statusLoading ? "Loading diagnostics…" : "Diagnostics unavailable."}</div>
        )}
      </div>
    </div>
  );
}
