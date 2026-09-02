import React, { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../../api";
import {
  SCREENSHOT_TYPES,
  SCREENSHOT_MAX_MB,
  validateScreenshotFile,
  screenshotStatusBanner,
} from "../routeScreenshot.mjs";
import { pasteRouter } from "./pasteRouter";
import {
  RESULT_LABELS, fmtMeters, fmtTime, trackingBadge, BLOCKED_REASON_TEXT, screenshotStatus,
} from "./formatters";

/**
 * One assigned route: its status, monitor history, driver-group delivery state,
 * and the screenshot management panel.
 *
 * SCREENSHOT TRANSPORT IS A PERMANENT INVARIANT (see
 * docs/architecture/route-control.md). Screenshots reach Telegram as
 * short-lived HMAC-signed HTTPS URLs — never bytes pushed from this process —
 * and replacing one invalidates the previous image's URLs. Nothing in this
 * component uploads to Telegram directly; it posts the file to the admin API
 * and the server mints the reference.
 *
 * Each row registers with the page-wide paste router under `row:<id>` while its
 * screenshot panel is open, and clears that key when the panel closes, so a
 * Ctrl+V lands on exactly the panel the admin is looking at.
 *
 * Split out of admin/src/pages/RouteControlPage.jsx.
 */
export function RouteRow({ a, completionRadius, onChanged, onMessage }) {
  const [busy, setBusy] = useState(false);
  const [details, setDetails] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  // Existing-route screenshot section: a toggled panel with click / drag-drop /
  // Ctrl+V paste + a local preview of the pending image before replacing.
  const [showShot, setShowShot] = useState(false);
  const [pendingShot, setPendingShot] = useState(null);
  const [pendingPreview, setPendingPreview] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const shotInputRef = useRef(null);
  const shotDropRef = useRef(null);

  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);
  useEffect(() => () => { if (pendingPreview) URL.revokeObjectURL(pendingPreview); }, [pendingPreview]);

  const clearPending = useCallback(() => {
    setPendingShot(null);
    setPendingPreview((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
    if (shotInputRef.current) shotInputRef.current.value = "";
  }, []);

  // Validate + stage a chosen/dropped/pasted image (shown as a local preview
  // before the admin confirms the replace). Invalid/oversized/unreadable images
  // produce a clear error and are not staged.
  const acceptPending = useCallback((file) => {
    const check = validateScreenshotFile(file);
    if (!check.ok) { onMessage({ type: "error", text: check.error }); return; }
    setPendingShot(file);
    setPendingPreview((prev) => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(file); });
  }, [onMessage]);

  // When THIS route's screenshot panel opens, make it the sole Ctrl+V paste
  // target and focus its dropzone so a paste lands here immediately — never in
  // the upper "Assign a route" form or another route row. Cleared on close/unmount.
  useEffect(() => {
    if (!showShot) { pasteRouter.clearActive(`row:${a.id}`); return undefined; }
    pasteRouter.setActive(`row:${a.id}`, acceptPending);
    const t = setTimeout(() => shotDropRef.current?.focus(), 0);
    return () => { clearTimeout(t); pasteRouter.clearActive(`row:${a.id}`); };
  }, [showShot, a.id, acceptPending]);

  const act = async (fn, okText) => {
    setBusy(true);
    try { await fn(); onMessage({ type: "success", text: okText }); await onChanged(); }
    catch (err) { onMessage({ type: "error", text: err.message }); }
    finally { setBusy(false); }
  };

  const sendRouteMessage = async () => {
    setBusy(true);
    try {
      const send = await api.sendRouteDriverMessage(a.id);
      const tagged = send.mentionConfidence === "high"
        ? " Driver tagged by Telegram ID."
        : send.mentionConfidence === "medium"
          ? " Driver tagged by @username."
          : " Sent with the driver's name (no Telegram account on file).";
      const extras = [
        send.withScreenshot ? " Screenshot attached." : "",
        send.trackingActivated ? " Tracking is now active." : "",
      ].join("");
      if (send.screenshotError) {
        onMessage({
          type: "warning",
          text: `Route message sent as TEXT ONLY — the screenshot could not be sent (${send.screenshotError}). `
            + `The screenshot is still stored; you can retry with “Re-send route message”.${tagged}${extras}`,
        });
      } else {
        onMessage({ type: "success", text: `Route message sent to the driver group.${tagged}${extras}` });
      }
      await onChanged();
    } catch (err) {
      onMessage({ type: "error", text: `Could not send the route message: ${err.message}` });
    } finally { setBusy(false); }
  };

  const viewDetails = async () => {
    if (details) { setDetails(null); return; }
    try { setDetails(await api.getRouteAssignment(a.id)); }
    catch (err) { onMessage({ type: "error", text: err.message }); }
  };

  const startTracking = async () => {
    setBusy(true);
    try {
      await api.startRouteTracking(a.id);
      onMessage({ type: "success", text: "Tracking started." });
      await onChanged();
    } catch (err) {
      onMessage({ type: "error", text: `Could not start tracking: ${err.message}` });
    } finally { setBusy(false); }
  };

  const runCompletionCheck = async () => {
    setBusy(true);
    try {
      const result = await api.runRouteCompletionCheck(a.id);
      const r = (result.results || [])[0];
      if (!r) {
        onMessage({ type: "warning", text: "Completion check ran but returned no result." });
      } else if (r.completed) {
        onMessage({
          type: "success",
          text: `Completed automatically at ${r.distanceMiles != null ? `${r.distanceMiles} miles` : "the destination"}.`,
        });
      } else {
        const why = BLOCKED_REASON_TEXT[r.blockedReason] || r.note || r.error || "not completed";
        const dist = r.distanceMiles != null ? `${r.distanceMiles} miles from destination — ` : "";
        onMessage({ type: "warning", text: `${dist}${why}${r.resolveError ? ` (${r.resolveError})` : ""}` });
      }
      await onChanged();
    } catch (err) {
      onMessage({ type: "error", text: `Completion check failed: ${err.message}` });
    } finally { setBusy(false); }
  };

  const previewScreenshot = async () => {
    if (previewUrl) { setPreviewUrl(null); return; }
    setBusy(true);
    try {
      const blob = await api.getRouteScreenshotBlob(a.id);
      setPreviewUrl(URL.createObjectURL(blob));
    } catch (err) {
      onMessage({ type: "error", text: `Could not load the screenshot: ${err.message}` });
    } finally { setBusy(false); }
  };

  // Replace the stored screenshot. This NEVER sends a new Telegram message — when
  // the route was already delivered the backend edits the existing message in
  // place. A failed upload leaves the previously stored screenshot intact.
  const replaceScreenshot = async () => {
    const file = pendingShot;
    if (!file) { onMessage({ type: "error", text: "Choose an image first." }); return; }
    const check = validateScreenshotFile(file);
    if (!check.ok) { onMessage({ type: "error", text: check.error }); return; }
    setBusy(true);
    try {
      const res = await api.uploadRouteScreenshot(a.id, file);
      clearPending();
      setPreviewUrl(null);
      setShowShot(false);
      onMessage(screenshotStatusBanner("replace", res));
      await onChanged();
    } catch (err) {
      // Storage failed → the previous screenshot is untouched.
      onMessage({ type: "error", text: `Screenshot upload failed: ${err.message} The previously stored screenshot was kept.` });
    } finally {
      setBusy(false);
    }
  };

  const removeScreenshot = async () => {
    setBusy(true);
    try {
      const res = await api.deleteRouteScreenshot(a.id);
      setPreviewUrl(null);
      clearPending();
      onMessage(screenshotStatusBanner("remove", res));
      await onChanged();
    } catch (err) {
      onMessage({ type: "error", text: `Could not remove the screenshot: ${err.message}` });
    } finally { setBusy(false); }
  };

  // Explicitly edit the already-sent Telegram message(s) in place (retry / push a
  // text edit) — never posts a new message.
  const updateInTelegram = async () => {
    setBusy(true);
    try {
      const res = await api.updateRouteDriverMessage(a.id);
      onMessage(screenshotStatusBanner("update", { telegram: res }));
      await onChanged();
    } catch (err) {
      onMessage({ type: "error", text: `Could not update the Telegram message: ${err.message}` });
    } finally { setBusy(false); }
  };

  const result = RESULT_LABELS[a.last_check_result] || { text: a.last_check_result || "—", color: "#94a3b8" };
  const statusBadge = a.status === "active" ? "badge-active" : "badge-inactive";
  const tracking = trackingBadge(a);
  const shot = screenshotStatus(a);
  const hasDestCoords = a.destination_lat != null && a.destination_lng != null;

  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div>
          <strong>{a.driver_label || a.group_name || `Group ${a.group_id}`}</strong>
          {a.unit_number && <span style={{ color: "#94a3b8", marginLeft: 8, fontFamily: "monospace" }}>Unit {a.unit_number}</span>}
          <span className={`badge ${statusBadge}`} style={{ marginLeft: 8 }}>{a.status}</span>
          {!a.encoded_polyline && <span className="badge badge-inactive" style={{ marginLeft: 6 }}>geometry pending</span>}
          {a.source === "telegram" && <span className="badge" style={{ marginLeft: 6 }}>📲 from Telegram</span>}
          {a.driver_group_message_sent_at && <span className="badge" style={{ marginLeft: 6 }}>✅ sent to group</span>}
          <span className="badge" style={{ marginLeft: 6, color: shot.color, borderColor: shot.color }} title={shot.title || ""}>
            {shot.text}
          </span>
          {tracking && (
            <span className="badge" style={{ marginLeft: 6, color: tracking.color, borderColor: tracking.color }}>
              {tracking.text}
            </span>
          )}
          <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>
            {a.origin_text || "?"} → {a.destination_text || "?"}
            {a.original_url && a.original_url.startsWith("http") && (
              <> · <a href={a.original_url} target="_blank" rel="noreferrer">link</a></>
            )}
          </div>
          {a.assigned_by && (
            <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 2 }}>
              Assigned by {a.assigned_by}{a.source === "telegram" ? " (Telegram)" : ""}
            </div>
          )}
          <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 2 }}>
            Route message: {a.driver_group_message_sent_at
              ? `sent ${fmtTime(a.driver_group_message_sent_at)}${a.driver_group_message_sent_by ? ` by ${a.driver_group_message_sent_by}` : ""}`
              : "not sent yet"}
          </div>
          <div style={{ fontSize: 12, marginTop: 4 }}>
            Last check: <span style={{ color: result.color }}>{result.text}</span>
            {" · "}Deviation: {fmtMeters(a.last_deviation_meters)}
            {" · "}Checked: {fmtTime(a.last_checked_at)}
            {a.last_notification_at && <> · Last warning: {fmtTime(a.last_notification_at)}</>}
          </div>
          {a.status === "active" && (
            <div style={{ fontSize: 12, marginTop: 4, color: "#94a3b8" }}>
              🏁 Destination coords: {hasDestCoords ? "Yes" : <span style={{ color: "#f87171" }}>No</span>}
              {" · "}Distance to destination: {fmtMeters(a.last_destination_distance_meters)}
              {completionRadius != null && <> (completes at {completionRadius} mi)</>}
              {" · "}Completion check: {fmtTime(a.last_completion_check_at)}
              {a.completion_blocked_reason && (
                <div style={{ color: a.completion_blocked_reason === "OUTSIDE_COMPLETION_RADIUS" ? "#94a3b8" : "#f59e0b", marginTop: 2 }}>
                  {BLOCKED_REASON_TEXT[a.completion_blocked_reason] || a.completion_blocked_reason}
                </div>
              )}
            </div>
          )}
          {a.status === "completed" && a.completed_at && (
            <div style={{ fontSize: 12, marginTop: 4, color: "#22c55e" }}>
              ✅ Completed {fmtTime(a.completed_at)}
              {a.completion_distance_meters != null && <> · {fmtMeters(a.completion_distance_meters)} from destination</>}
              {a.completion_latitude != null && a.completion_longitude != null && (
                <> · Final GPS {a.completion_latitude.toFixed(4)}, {a.completion_longitude.toFixed(4)}</>
              )}
              {a.completion_reason && (
                <div style={{ color: "#94a3b8", marginTop: 2 }}>{a.completion_reason}</div>
              )}
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "flex-start" }}>
          <button className="btn btn-ghost btn-sm" onClick={viewDetails}>{details ? "Hide" : "Details"}</button>
          {a.status === "active" && !a.driver_group_message_sent_at && (
            <button className="btn btn-ghost btn-sm" onClick={sendRouteMessage} disabled={busy}
              title="Posts the route message to the driver group for the first time.">
              Send route message
            </button>
          )}
          {a.status === "active" && a.driver_group_message_sent_at && (
            <>
              <button className="btn btn-ghost btn-sm" onClick={updateInTelegram} disabled={busy}
                title="Edits the message already in the driver group in place — does NOT post a new message.">
                Update message in Telegram
              </button>
              <button className="btn btn-ghost btn-sm" onClick={sendRouteMessage} disabled={busy}
                title="Posts a brand-new message to the driver group. Use only if the existing message is gone.">
                Send as new message
              </button>
            </>
          )}
          {a.status === "active" && a.tracking_status === "pending" && (
            <button className="btn btn-ghost btn-sm" onClick={startTracking} disabled={busy}>
              Start tracking now
            </button>
          )}
          {!a.encoded_polyline && a.status === "active" && (
            <button className="btn btn-ghost btn-sm" onClick={() => act(() => api.computeRouteGeometry(a.id), "Geometry computed.")} disabled={busy}>Compute</button>
          )}
          {a.status === "active" && (
            <button className="btn btn-ghost btn-sm" onClick={runCompletionCheck} disabled={busy} title={`Resolve GPS and check destination completion now${completionRadius != null ? ` (${completionRadius}-mile radius)` : ""}`}>
              Check completion now
            </button>
          )}
          {a.has_screenshot && (
            <button className="btn btn-ghost btn-sm" onClick={previewScreenshot} disabled={busy}>
              {previewUrl ? "Hide screenshot" : "Preview screenshot"}
            </button>
          )}
          {a.status === "active" && (
            <button className="btn btn-ghost btn-sm" onClick={() => setShowShot((v) => !v)} disabled={busy}>
              {showShot ? "Close screenshot panel" : (a.has_screenshot ? "Manage screenshot" : "Add screenshot")}
            </button>
          )}
          {a.has_screenshot && a.status === "active" && (
            <button className="btn btn-ghost btn-sm" onClick={removeScreenshot} disabled={busy}>
              Remove screenshot
            </button>
          )}
          {a.status === "active" && (
            <>
              <button className="btn btn-ghost btn-sm" onClick={() => act(() => api.completeRoute(a.id), "Route completed.")} disabled={busy}>Complete</button>
              <button className="btn btn-danger btn-sm" onClick={() => act(() => api.cancelRoute(a.id), "Route cancelled.")} disabled={busy}>Cancel</button>
            </>
          )}
        </div>
      </div>
      {showShot && a.status === "active" && (
        <div style={{ marginTop: 12, borderTop: "1px solid rgba(148,163,184,0.15)", paddingTop: 10 }}>
          <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 6 }}>
            {a.has_screenshot ? "Replace" : "Add"} the route screenshot. Replacing or removing it updates the
            already-sent Telegram message <strong>in place</strong> — it never posts a new message to the group.
          </div>
          <div
            ref={shotDropRef}
            tabIndex={0}
            role="button"
            aria-label="Screenshot dropzone — click to choose, or focus and press Ctrl+V to paste"
            onFocus={() => pasteRouter.setActive(`row:${a.id}`, acceptPending)}
            onClick={() => { pasteRouter.setActive(`row:${a.id}`, acceptPending); shotInputRef.current?.click(); }}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); acceptPending(e.dataTransfer?.files?.[0]); }}
            style={{
              border: `1.5px dashed ${dragOver ? "#60a5fa" : "rgba(148,163,184,0.4)"}`,
              borderRadius: 8, padding: pendingPreview ? 8 : 16, cursor: "pointer", outline: "none",
              background: dragOver ? "rgba(59,130,246,0.08)" : "rgba(148,163,184,0.04)", textAlign: "center",
            }}
          >
            {pendingPreview ? (
              <div style={{ display: "flex", alignItems: "center", gap: 12, textAlign: "left" }}>
                <img src={pendingPreview} alt="New screenshot preview" style={{ maxHeight: 120, maxWidth: 220, borderRadius: 6 }} />
                <div style={{ fontSize: 12, color: "#94a3b8" }}>
                  <div>{pendingShot?.name || "pasted image"} · {(pendingShot?.size / 1048576).toFixed(1)} MB</div>
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <button className="btn btn-primary btn-sm" onClick={(e) => { e.stopPropagation(); replaceScreenshot(); }} disabled={busy}>
                      {a.has_screenshot ? "Replace screenshot" : "Upload screenshot"}
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); clearPending(); }} disabled={busy}>Cancel</button>
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 13, color: "#94a3b8" }}>
                Click to choose an image, drag &amp; drop it here, or click here then press <strong>Ctrl+V</strong> to paste a screenshot.
                <div style={{ fontSize: 11, marginTop: 4 }}>PNG, JPG or WEBP · up to {SCREENSHOT_MAX_MB} MB</div>
              </div>
            )}
          </div>
          <input
            ref={shotInputRef}
            type="file"
            accept={SCREENSHOT_TYPES.join(",")}
            style={{ display: "none" }}
            onChange={(e) => { acceptPending(e.target.files?.[0]); if (shotInputRef.current) shotInputRef.current.value = ""; }}
          />
        </div>
      )}
      {previewUrl && (
        <div style={{ marginTop: 12, borderTop: "1px solid rgba(148,163,184,0.15)", paddingTop: 10 }}>
          <img
            src={previewUrl}
            alt={`Route screenshot for ${a.group_name || `route ${a.id}`}`}
            style={{ maxWidth: "100%", maxHeight: 420, borderRadius: 8, cursor: "pointer" }}
            onClick={() => setPreviewUrl(null)}
            title="Click to close"
          />
        </div>
      )}
      {details && (
        <div style={{ marginTop: 12, borderTop: "1px solid rgba(148,163,184,0.15)", paddingTop: 10 }}>
          <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 6 }}>
            Distance: {a.distance_meters ? `${(a.distance_meters / 1609.34).toFixed(1)} mi` : "—"} ·
            {" "}Last known location: {a.last_latitude != null ? `${a.last_latitude.toFixed(4)}, ${a.last_longitude.toFixed(4)}` : "—"}
          </div>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Recent monitor events</div>
          {(details.events || []).length === 0 ? (
            <div style={{ fontSize: 12, color: "#94a3b8" }}>No events yet.</div>
          ) : (
            details.events.slice(0, 15).map((e) => (
              <div key={e.id} style={{ fontSize: 12, color: "#cbd5e1", marginBottom: 2 }}>
                {fmtTime(e.created_at)} · <strong>{e.event_type}</strong>
                {e.result ? ` (${e.result})` : ""} · {fmtMeters(e.deviation_meters)}
                {e.detail ? ` — ${e.detail}` : ""}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
