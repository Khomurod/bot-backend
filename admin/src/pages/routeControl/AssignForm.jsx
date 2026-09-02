import React, { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../../api";
import {
  SCREENSHOT_TYPES,
  SCREENSHOT_MAX_MB,
  validateScreenshotFile,
} from "../routeScreenshot.mjs";
import { pasteRouter } from "./pasteRouter";
import { SearchableGroupSelect } from "./SearchableGroupSelect";
import { TRACKING_MODES, parseWaypoints } from "./formatters";

/**
 * Assign a Google Maps route to a driver group.
 *
 * "Test parse" is separate from "Assign" on purpose: an admin confirms the URL
 * resolved to the intended origin/destination/waypoints BEFORE anything reaches
 * a driver's Telegram group.
 *
 * The screenshot accepts click, drag-and-drop and Ctrl+V, all through the one
 * page-wide paste router (./pasteRouter.js) under the key "assign", cleared on
 * unmount so a paste cannot land here once the form is gone.
 *
 * Tracking start modes decide WHEN monitoring begins — on message delivery, at
 * a time, or on reaching a location within a radius — which is why the radius
 * and location inputs appear with the mode rather than always.
 *
 * Split out of admin/src/pages/RouteControlPage.jsx.
 */
export function AssignForm({ options, onAssigned, onMessage }) {
  const [groupId, setGroupId] = useState("");
  const [url, setUrl] = useState("");
  const [origin, setOrigin] = useState("");
  const [destination, setDestination] = useState("");
  const [waypoints, setWaypoints] = useState("");
  const [sendToGroup, setSendToGroup] = useState(true);
  const [parsed, setParsed] = useState(null);
  const [busy, setBusy] = useState(false);
  // Route screenshot (upload / drag-drop / Ctrl+V paste) with local preview.
  const [screenshot, setScreenshot] = useState(null);
  const [screenshotPreview, setScreenshotPreview] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  // Tracking start controls.
  const [startMode, setStartMode] = useState("after_message_sent");
  const [startAt, setStartAt] = useState("");
  const [startLocation, setStartLocation] = useState("");
  const [startRadius, setStartRadius] = useState("2");
  const fileInputRef = useRef(null);

  const clearScreenshot = useCallback(() => {
    setScreenshot(null);
    setScreenshotPreview((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  const acceptScreenshot = useCallback((file) => {
    if (!file) return;
    const check = validateScreenshotFile(file);
    if (!check.ok) { onMessage({ type: "error", text: check.error }); return; }
    setScreenshot(file);
    setScreenshotPreview((prev) => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(file); });
  }, [onMessage]);

  // Ctrl+V is scoped: this form only receives a pasted image while its own
  // screenshot dropzone is the active paste target (focused). Clear on unmount so
  // it never keeps stealing pastes meant for a route's "Manage screenshot" panel.
  useEffect(() => () => pasteRouter.clearActive("assign"), []);

  const resetInputs = () => {
    setUrl(""); setOrigin(""); setDestination(""); setWaypoints(""); setParsed(null);
    clearScreenshot();
    setStartMode("after_message_sent"); setStartAt(""); setStartLocation(""); setStartRadius("2");
  };

  const testParse = async () => {
    setBusy(true); setParsed(null);
    try {
      const result = await api.parseRouteLink(url.trim());
      setParsed(result);
      onMessage({ type: "success", text: "Link parsed. Review the origin/destination below, then assign." });
    } catch (err) {
      onMessage({
        type: "error",
        text: `${err.message} You can also enter Origin and Destination below and assign manually.`,
      });
    } finally { setBusy(false); }
  };

  /** Report the outcome, distinguishing full success from every partial state
   *  (screenshot store failed / photo fell back to text / send failed). */
  const reportResult = (result) => {
    const trackingNote = result.trackingStatus === "pending"
      ? " Tracking is pending until its start condition is met."
      : " Monitoring is active.";
    const base = result.geometryPending
      ? "Route saved. Geometry is pending — enable Google Maps in Settings → GMaps, then Compute."
      : `Route assigned and geometry computed.${trackingNote}`;
    const shotNote = result.screenshot && result.screenshot.stored === false
      ? ` ⚠️ The screenshot could NOT be stored (${result.screenshot.error || "unknown error"}) — the route was kept; upload it again with “Upload screenshot” on the route below.`
      : "";
    if (result.driverMessage && result.driverMessage.sent === false) {
      onMessage({
        type: "warning",
        text: `${base}${shotNote} However, the route message could NOT be sent to the driver group: `
          + `${result.driverMessage.error || "unknown error"}. Use “Send route message” on the route below to retry.`,
      });
    } else if (result.driverMessage && result.driverMessage.sent && result.driverMessage.screenshotError) {
      onMessage({
        type: "warning",
        text: `${base}${shotNote} Route message was sent as TEXT ONLY — the screenshot could not be sent `
          + `(${result.driverMessage.screenshotError}). It is still stored; re-send to retry.`,
      });
    } else if (result.driverMessage && result.driverMessage.sent) {
      const withShot = result.driverMessage.withScreenshot ? " (with screenshot)" : "";
      onMessage({ type: "success", text: `${base}${shotNote} Route message sent to the driver group${withShot}.` });
    } else {
      onMessage({ type: "success", text: `${base}${shotNote}` });
    }
  };

  const assign = async () => {
    if (!groupId) { onMessage({ type: "error", text: "Pick a driver group." }); return; }
    const hasManual = origin.trim() && destination.trim();
    if (!url.trim() && !hasManual) {
      onMessage({ type: "error", text: "Paste a Google Maps directions link, or enter Origin and Destination." });
      return;
    }
    if (startMode === "scheduled_time" && !startAt) {
      onMessage({ type: "error", text: "Pick the date/time tracking should start." });
      return;
    }
    if (startMode === "start_location" && !startLocation.trim()) {
      onMessage({ type: "error", text: "Enter the start location as coordinates (lat, lng)." });
      return;
    }
    setBusy(true);
    try {
      const tracking = { startMode };
      if (startMode === "scheduled_time") tracking.startAt = new Date(startAt).toISOString();
      if (startMode === "start_location") {
        tracking.startLocation = startLocation.trim();
        tracking.startRadiusMiles = Number(startRadius) || 2;
      }
      const payloadBase = { groupId: Number(groupId), sendToDriverGroup: sendToGroup, tracking };
      // With a screenshot the payload goes multipart; otherwise plain JSON (unchanged).
      const submit = (payload) => (screenshot
        ? api.assignRouteWithScreenshot(payload, screenshot)
        : api.assignRoute(payload));
      let result;
      if (url.trim() && !hasManual) {
        result = await submit({ ...payloadBase, url: url.trim() });
      } else if (!url.trim() && hasManual) {
        result = await submit({
          ...payloadBase,
          manual: { origin: origin.trim(), destination: destination.trim(), waypoints: parseWaypoints(waypoints) },
        });
      } else {
        try {
          result = await submit({ ...payloadBase, url: url.trim() });
        } catch (linkErr) {
          onMessage({ type: "error", text: `${linkErr.message} Falling back to the Origin/Destination you entered…` });
          result = await submit({
            ...payloadBase,
            url: url.trim(),
            manual: { origin: origin.trim(), destination: destination.trim(), waypoints: parseWaypoints(waypoints) },
          });
        }
      }
      resetInputs();
      reportResult(result);
      await onAssigned();
    } catch (err) { onMessage({ type: "error", text: err.message }); }
    finally { setBusy(false); }
  };

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <h3 style={{ marginTop: 0 }}>➕ Assign a route</h3>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
        <div className="form-group" style={{ marginBottom: 0, minWidth: 280, flex: 1 }}>
          <label style={{ display: "block", fontSize: 12, marginBottom: 4 }}>Driver group</label>
          <SearchableGroupSelect options={options} value={groupId} onChange={setGroupId} disabled={busy} />
        </div>
        <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 280 }}>
          <label style={{ display: "block", fontSize: 12, marginBottom: 4 }}>Google Maps directions link</label>
          <input className="form-input" value={url} placeholder="https://www.google.com/maps/dir/…" onChange={(e) => setUrl(e.target.value)} />
        </div>
      </div>

      <div style={{ fontSize: 12, color: "#94a3b8", margin: "12px 0 6px" }}>
        Or enter the route manually (used when the link is a place/map view or can't be read):
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-start" }}>
        <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 200 }}>
          <label style={{ display: "block", fontSize: 12, marginBottom: 4 }}>Origin</label>
          <input className="form-input" value={origin} placeholder="e.g. Chicago, IL" onChange={(e) => setOrigin(e.target.value)} />
        </div>
        <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 200 }}>
          <label style={{ display: "block", fontSize: 12, marginBottom: 4 }}>Destination</label>
          <input className="form-input" value={destination} placeholder="e.g. Dallas, TX" onChange={(e) => setDestination(e.target.value)} />
        </div>
        <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 200 }}>
          <label style={{ display: "block", fontSize: 12, marginBottom: 4 }}>Waypoints (comma or newline separated)</label>
          <textarea className="form-input" value={waypoints} rows={2} placeholder="e.g. St. Louis, MO, Little Rock, AR" onChange={(e) => setWaypoints(e.target.value)} />
        </div>
      </div>

      {/* Route screenshot: click, drag/drop, or Ctrl+V paste. */}
      <div style={{ marginTop: 14 }}>
        <label style={{ display: "block", fontSize: 12, marginBottom: 4 }}>
          Route screenshot (optional — sent to the driver group with the route message)
        </label>
        <div
          tabIndex={0}
          role="button"
          aria-label="Route screenshot dropzone — click to choose, or focus and press Ctrl+V to paste"
          onFocus={() => pasteRouter.setActive("assign", acceptScreenshot)}
          onClick={() => { pasteRouter.setActive("assign", acceptScreenshot); fileInputRef.current?.click(); }}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); acceptScreenshot(e.dataTransfer?.files?.[0]); }}
          style={{
            border: `1.5px dashed ${dragOver ? "#60a5fa" : "rgba(148,163,184,0.4)"}`,
            borderRadius: 8, padding: screenshotPreview ? 8 : 18, cursor: "pointer", outline: "none",
            background: dragOver ? "rgba(59,130,246,0.08)" : "rgba(148,163,184,0.04)",
            textAlign: "center",
          }}
        >
          {screenshotPreview ? (
            <div style={{ display: "flex", alignItems: "center", gap: 12, textAlign: "left" }}>
              <img src={screenshotPreview} alt="Route screenshot preview" style={{ maxHeight: 120, maxWidth: 220, borderRadius: 6 }} />
              <div style={{ fontSize: 12, color: "#94a3b8" }}>
                <div>{screenshot?.name || "pasted image"} · {(screenshot?.size / 1048576).toFixed(1)} MB</div>
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
                  >Replace</button>
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={(e) => { e.stopPropagation(); clearScreenshot(); }}
                  >Remove</button>
                </div>
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 13, color: "#94a3b8" }}>
              Click to choose an image, drag &amp; drop it here, or press <strong>Ctrl+V</strong> to paste a screenshot.
              <div style={{ fontSize: 11, marginTop: 4 }}>PNG, JPG or WEBP · up to {SCREENSHOT_MAX_MB} MB</div>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept={SCREENSHOT_TYPES.join(",")}
            style={{ display: "none" }}
            onChange={(e) => acceptScreenshot(e.target.files?.[0])}
          />
        </div>
      </div>

      {/* Tracking start controls. */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end", marginTop: 14 }}>
        <div className="form-group" style={{ marginBottom: 0, minWidth: 280 }}>
          <label style={{ display: "block", fontSize: 12, marginBottom: 4 }}>Tracking starts</label>
          <select className="form-input" value={startMode} onChange={(e) => setStartMode(e.target.value)}>
            {TRACKING_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </div>
        {startMode === "scheduled_time" && (
          <div className="form-group" style={{ marginBottom: 0, minWidth: 220 }}>
            <label style={{ display: "block", fontSize: 12, marginBottom: 4 }}>Start at</label>
            <input className="form-input" type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} />
          </div>
        )}
        {startMode === "start_location" && (
          <>
            <div className="form-group" style={{ marginBottom: 0, minWidth: 240 }}>
              <label style={{ display: "block", fontSize: 12, marginBottom: 4 }}>Start location (lat, lng)</label>
              <input
                className="form-input" value={startLocation} placeholder="e.g. 35.2331, -85.7095"
                onChange={(e) => setStartLocation(e.target.value)}
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0, width: 130 }}>
              <label style={{ display: "block", fontSize: 12, marginBottom: 4 }}>Radius (miles)</label>
              <input
                className="form-input" type="number" min="0.25" max="100" step="0.25"
                value={startRadius} onChange={(e) => setStartRadius(e.target.value)}
              />
            </div>
          </>
        )}
      </div>
      {startMode === "after_message_sent" && (
        <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 4 }}>
          Tracking stays pending until the route message is successfully sent to the driver group.
        </div>
      )}
      {startMode === "start_location" && (
        <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 4 }}>
          Right-click the spot in Google Maps and copy the coordinates. Tracking starts when the truck is within the radius.
        </div>
      )}

      <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, fontSize: 13, cursor: "pointer" }}>
        <input type="checkbox" checked={sendToGroup} onChange={(e) => setSendToGroup(e.target.checked)} />
        Send route message to driver group
      </label>

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button className="btn btn-ghost btn-sm" onClick={testParse} disabled={busy || !url.trim()}>Test parse route</button>
        <button className="btn btn-primary btn-sm" onClick={assign} disabled={busy}>Assign route</button>
      </div>
      {parsed && (
        <div style={{ marginTop: 12, fontSize: 13, color: "#cbd5e1", background: "rgba(148,163,184,0.08)", padding: 10, borderRadius: 8 }}>
          <div><strong>Origin:</strong> {parsed.origin?.raw || "—"}</div>
          <div><strong>Destination:</strong> {parsed.destination?.raw || "—"}</div>
          <div><strong>Waypoints:</strong> {parsed.waypoints?.length ? parsed.waypoints.map((w) => w.raw).join(" · ") : "none"}</div>
          {parsed.expandedUrl && <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 4 }}>Expanded short link.</div>}
        </div>
      )}
      <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 10 }}>
        Paste a Google Maps <strong>Directions</strong> link (with a start and end). Shortened <code>maps.app.goo.gl</code>
        links are expanded automatically. A place/map-view link (e.g. <code>/maps/@lat,lng</code>) can't become a route —
        in that case enter Origin and Destination above and assign manually.
      </div>
    </div>
  );
}
