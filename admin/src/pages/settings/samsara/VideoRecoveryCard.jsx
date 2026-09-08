import React, { useCallback, useEffect, useState } from "react";
import * as api from "../../../api";
import { NumField } from "../fields";

const STATUS_LABELS = {
  pending_recheck: "Waiting for the first re-check",
  pending_retrieval: "Waiting on Samsara footage",
  video_available: "Video found — updating Telegram",
  completed: "Telegram updated",
  no_video: "No video available",
  failed: "Failed",
};

/**
 * Missing-video recovery: the controls, and what the recovery queue is doing.
 *
 * The behaviour these settings drive: a safety event whose clip has not
 * uploaded yet is ALERTED IMMEDIATELY, text-only, and a durable job is written.
 * The job is re-checked after the initial delay; if Samsara still has no clip
 * and retrieval is on, footage is requested once and polled until it appears or
 * the attempt budget runs out. The alert itself is never held back for video.
 */
export function VideoRecoveryCard({ form, setField, recovery }) {
  const [jobs, setJobs] = useState(null);
  const [loadingJobs, setLoadingJobs] = useState(false);

  const loadJobs = useCallback(async () => {
    setLoadingJobs(true);
    try { setJobs(await api.getSamsaraVideoRecovery({ limit: 15 })); }
    catch { setJobs(null); }
    finally { setLoadingJobs(false); }
  }, []);
  useEffect(() => { loadJobs(); }, [loadJobs]);

  const counts = jobs?.byStatus || recovery?.byStatus || {};
  const totalOpen = (counts.pending_recheck || 0) + (counts.pending_retrieval || 0)
    + (counts.video_available || 0);

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3 style={{ marginTop: 0 }}>🎥 Missing video recovery</h3>
      <p style={{ color: "#94a3b8", fontSize: 13, marginTop: 0 }}>
        Safety alerts always go out <strong>immediately</strong>, with the clip when Samsara
        already has one. When it does not, the alert is sent as text and the video is folded
        in later — the alert is never delayed waiting for footage.
      </p>

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14, marginBottom: 10 }}>
        <input
          type="checkbox"
          checked={form.videoRecoveryEnabled}
          onChange={(e) => setField("videoRecoveryEnabled", e.target.checked)}
        /> Enable automatic missing-video recovery
      </label>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 24 }}>
        <NumField
          label="Wait before re-checking Samsara"
          value={form.videoRecoveryInitialDelaySeconds}
          onChange={(v) => setField("videoRecoveryInitialDelaySeconds", v)}
          suffix={`seconds (${minutesLabel(form.videoRecoveryInitialDelaySeconds)})`}
        />
      </div>

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14, margin: "10px 0" }}>
        <input
          type="checkbox"
          checked={form.videoRetrievalEnabled}
          onChange={(e) => setField("videoRetrievalEnabled", e.target.checked)}
        /> Ask Samsara to retrieve footage when the re-check still has none
      </label>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 24 }}>
        <NumField
          label="Time between later checks"
          value={form.videoRecoveryRetryIntervalSeconds}
          onChange={(v) => setField("videoRecoveryRetryIntervalSeconds", v)}
          suffix={`seconds (${minutesLabel(form.videoRecoveryRetryIntervalSeconds)})`}
        />
        <NumField
          label="Give up after"
          value={form.videoRecoveryMaxAttempts}
          onChange={(v) => setField("videoRecoveryMaxAttempts", v)}
          suffix="checks"
        />
      </div>

      <details className="collapse-panel" style={{ marginTop: 8 }}>
        <summary>Footage window around the event</summary>
        <p style={{ fontSize: 12, color: "#94a3b8" }}>
          How much video to request either side of the event. Samsara rejects a zero-length
          request, so these are also what guarantees a real interval for an event that
          reports only a single instant.
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 24 }}>
          <NumField
            label="Before the event"
            value={form.videoRetrievalWindowBeforeSeconds}
            onChange={(v) => setField("videoRetrievalWindowBeforeSeconds", v)}
            suffix="seconds"
          />
          <NumField
            label="After the event"
            value={form.videoRetrievalWindowAfterSeconds}
            onChange={(v) => setField("videoRetrievalWindowAfterSeconds", v)}
            suffix="seconds"
          />
        </div>
      </details>

      <div style={{ marginTop: 12, borderTop: "1px solid rgba(148,163,184,0.2)", paddingTop: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <strong style={{ fontSize: 14 }}>Recovery queue</strong>
          <span style={{ fontSize: 12, color: "#94a3b8" }}>
            {totalOpen} in progress
            {jobs?.nextDueAt ? ` · next check ${new Date(jobs.nextDueAt).toLocaleString()}` : ""}
          </span>
          <button className="btn btn-ghost btn-sm" onClick={loadJobs} disabled={loadingJobs}>
            {loadingJobs ? "Refreshing…" : "Refresh"}
          </button>
        </div>

        {jobs && jobs.available === false && (
          <div style={{ fontSize: 12, color: "#f59e0b", marginTop: 6 }}>
            The recovery table is not present yet — it is created by the next deploy&apos;s migration.
          </div>
        )}

        {jobs?.jobs?.length > 0 && (
          <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse", marginTop: 8 }}>
            <tbody>
              {jobs.jobs.map((job) => (
                <tr key={job.id} style={{ borderTop: "1px solid rgba(148,163,184,0.15)" }}>
                  <td style={{ padding: "6px 4px" }}>
                    <code>{job.samsara_event_id}</code>
                    <div style={{ color: "#94a3b8" }}>
                      {job.event_time ? new Date(job.event_time).toLocaleString() : "unknown time"}
                      {job.is_speeding ? " · speeding" : ""}
                    </div>
                  </td>
                  <td style={{ padding: "6px 4px" }}>
                    {STATUS_LABELS[job.status] || job.status}
                    <div style={{ color: "#94a3b8" }}>
                      {job.attempts} check{job.attempts === 1 ? "" : "s"}
                      {job.retrieval_id ? " · retrieval requested" : ""}
                    </div>
                  </td>
                  <td style={{ padding: "6px 4px", color: "#f87171", maxWidth: 260 }}>
                    {job.last_error || ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {jobs?.jobs?.length === 0 && (
          <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 6 }}>
            Nothing recorded — every safety event so far arrived with its video.
          </div>
        )}
      </div>
    </div>
  );
}

function minutesLabel(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n < 60) return `${n}s`;
  const mins = n / 60;
  return `${Number.isInteger(mins) ? mins : mins.toFixed(1)} min`;
}
