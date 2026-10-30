import React, { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../../../api";
import { Banner } from "../fields";

/**
 * The video /dispatchteam plays after the 4 PM celebration (the owner,
 * 26 October 2026): see it, pause and resume it, replace it, delete it.
 *
 * Pause is the video only — the car still celebrates the leader at 4 PM. A
 * screen playing the video when it is paused closes it on its next poll, within
 * about thirty seconds; nothing has to be reloaded.
 */

const formatSize = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
const formatWhen = (iso) => (iso ? new Date(iso).toLocaleString() : "");

function isMp4(file) {
  return file.type === "video/mp4" || /\.mp4$/i.test(file.name || "");
}

export default function CelebrationVideoCard() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null); // null | "pause" | "delete" | "upload"
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState(null);
  const fileInput = useRef(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api.getCelebrationVideoStatus());
    } catch (err) { setMessage({ type: "error", text: err.message }); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const run = async (kind, action, done) => {
    setBusy(kind); setMessage(null);
    try {
      await action();
      setMessage({ type: "success", text: done });
      await load();
    } catch (err) { setMessage({ type: "error", text: err.message }); }
    finally { setBusy(null); setProgress(0); }
  };

  const togglePause = () => {
    const pausing = !status.paused;
    return run("pause", () => api.setCelebrationVideoPaused(pausing), pausing
      ? "Paused. The screens close the video within about 30 seconds; the car still shows at 4 PM."
      : "Resumed. The video plays again after the 4 PM car.");
  };

  const remove = () => {
    if (!window.confirm("Delete the celebration video from the server? The car will show alone at 4 PM until a new video is uploaded.")) return;
    run("delete", () => api.deleteCelebrationVideo(), "Deleted. The car shows alone at 4 PM.");
  };

  const upload = (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = "";
    if (!file) return;
    if (!isMp4(file)) { setMessage({ type: "error", text: "Choose an MP4 video (.mp4)." }); return; }
    if (file.size > api.GROSS_RACE_VIDEO_MAX_BYTES) {
      setMessage({ type: "error", text: `That video is ${formatSize(file.size)}; the limit is ${formatSize(api.GROSS_RACE_VIDEO_MAX_BYTES)}.` });
      return;
    }
    run("upload", () => api.uploadCelebrationVideo(file, setProgress), status && status.paused
      ? "Uploaded. It is still paused — press Resume to play it after the 4 PM car."
      : "Uploaded. The screens play the new video from the next celebration.");
  };

  if (loading) return <div style={{ padding: 20, color: "var(--text-muted)" }}>Loading…</div>;

  const exists = Boolean(status && status.exists);
  const paused = Boolean(status && status.paused);
  return (
    <div className="ios-glass" style={{ padding: 20, marginBottom: 20 }}>
      <h3 style={{ marginTop: 0 }}>Video after the 4 PM celebration</h3>
      <p style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 0 }}>
        Plays on <strong>/dispatchteam</strong> right after the 3D car, with sound where the screen allows it.
        <strong> /dispatch</strong> shows the car only.
      </p>

      <Banner message={message} />

      {status && (
        <div style={{ fontSize: 14, margin: "8px 0 14px" }}>
          {!exists && <div>No video on the server — the car shows alone at 4 PM.</div>}
          {exists && (
            <div>
              Status: <strong data-testid="video-state">{paused ? "⏸ Paused" : "▶️ On"}</strong>
              {" · "}{formatSize(status.bytes)} · uploaded {formatWhen(status.updatedAt)}
              {status.pausedChangedAt && (
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
                  {paused ? "Paused" : "Last resumed"} {formatWhen(status.pausedChangedAt)}
                  {status.pausedChangedBy ? ` by ${status.pausedChangedBy}` : ""}
                </div>
              )}
            </div>
          )}
          {status.pauseError && (
            <div className="alert alert-error" style={{ marginTop: 8 }}>
              The pause setting could not be read, so the video is treated as paused. Press Resume to save it again.
            </div>
          )}
        </div>
      )}

      {exists && (
        <video
          controls
          preload="metadata"
          src={`${api.GROSS_RACE_VIDEO_URL}?v=${encodeURIComponent(status.updatedAt || "")}`}
          style={{ width: "100%", maxWidth: 560, borderRadius: 8, background: "#000", display: "block", marginBottom: 14 }}
        />
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {exists && (
          <button className={`btn ${paused ? "btn-primary" : "btn-ghost"} touch-target`} onClick={togglePause} disabled={Boolean(busy)}>
            {busy === "pause" ? "Saving…" : paused ? "▶️ Resume" : "⏸ Pause"}
          </button>
        )}
        <button className="btn btn-ghost touch-target" onClick={() => fileInput.current && fileInput.current.click()} disabled={Boolean(busy)}>
          {busy === "upload" ? `Uploading… ${Math.round(progress * 100)}%` : exists ? "⬆️ Upload a new video" : "⬆️ Upload a video"}
        </button>
        {exists && (
          <button className="btn btn-ghost touch-target" style={{ color: "var(--danger)" }} onClick={remove} disabled={Boolean(busy)}>
            {busy === "delete" ? "Deleting…" : "🗑 Delete"}
          </button>
        )}
        <input ref={fileInput} type="file" accept="video/mp4,.mp4" aria-label="Choose a video" style={{ display: "none" }} onChange={upload} />
      </div>
      <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>
        MP4 only, up to 100 MB. A new video replaces the old one only once it has fully arrived.
      </div>
    </div>
  );
}
