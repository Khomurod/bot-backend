import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../api";
import { buildGroupOptions, filterGroupOptions } from "./routeControlGroupSearch.mjs";

/**
 * Route Control — assign a Google Maps directions route to a driver group and
 * watch whether the driver follows it. Routes are monitored server-side against
 * the driver's live GPS; the driver group is warned when they drift off route.
 * Google Maps must be configured in Settings → GMaps for geometry to compute and
 * monitoring to run. The admin can also push the assigned route straight into the
 * driver's Telegram group (tagging the driver when we know their Telegram id/handle).
 */

const RESULT_LABELS = {
  on_route: { text: "On route", color: "#22c55e" },
  off_route: { text: "Off route", color: "#f87171" },
  parked: { text: "Parked/slow", color: "#94a3b8" },
  stale: { text: "Stale GPS", color: "#f59e0b" },
  not_checked: { text: "Not checked", color: "#94a3b8" },
  no_geometry: { text: "No geometry", color: "#f59e0b" },
};

function Banner({ message }) {
  if (!message) return null;
  const type = message.type === "error" ? "error" : message.type === "warning" ? "warning" : "success";
  return <div className={`alert alert-${type}`}>{message.text}</div>;
}

function fmtMeters(m) {
  if (m == null) return "—";
  const miles = m / 1609.34;
  return miles >= 0.1 ? `${miles.toFixed(1)} mi` : `${Math.round(m)} m`;
}

function fmtTime(iso) {
  return iso ? new Date(iso).toLocaleString() : "—";
}

/** Split waypoints entered comma- OR newline-separated into a clean array. */
function parseWaypoints(raw) {
  return String(raw || "")
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Searchable single-select combobox: type to filter driver groups by unit
 * number, driver name, group title or driver type. Keyboard + mouse friendly.
 */
function SearchableGroupSelect({ options, value, onChange, disabled }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const wrapRef = useRef(null);

  const selected = useMemo(
    () => options.find((o) => o.groupId === Number(value)) || null,
    [options, value]
  );

  const filtered = useMemo(() => filterGroupOptions(options, query), [options, query]);

  useEffect(() => {
    function onDocClick(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  useEffect(() => { setHighlight(0); }, [query, open]);

  const choose = (opt) => {
    if (!opt) return;
    onChange(String(opt.groupId));
    setQuery("");
    setOpen(false);
  };

  const onKeyDown = (e) => {
    if (!open && (e.key === "ArrowDown" || e.key === "Enter")) { setOpen(true); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setHighlight((h) => Math.min(h + 1, filtered.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); choose(filtered[highlight]); }
    else if (e.key === "Escape") { setOpen(false); }
  };

  const displayText = open ? query : (selected ? selected.label : "");

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <input
        className="form-input"
        role="combobox"
        aria-expanded={open}
        aria-label="Search driver group"
        disabled={disabled}
        placeholder={selected ? selected.label : "Search unit #, driver name or group…"}
        value={displayText}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {selected && !open && (
        <span
          onClick={() => !disabled && onChange("")}
          title="Clear selection"
          style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", cursor: "pointer", color: "#94a3b8" }}
        >×</span>
      )}
      {open && (
        <div
          style={{
            position: "absolute", zIndex: 20, top: "calc(100% + 4px)", left: 0, right: 0,
            maxHeight: 280, overflowY: "auto", background: "var(--card-bg, #0f172a)",
            border: "1px solid var(--border, rgba(148,163,184,0.3))", borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
          }}
        >
          {filtered.length === 0 ? (
            <div style={{ padding: "10px 12px", fontSize: 13, color: "#94a3b8" }}>No matching driver groups.</div>
          ) : (
            filtered.slice(0, 100).map((o, i) => (
              <div
                key={o.groupId}
                onMouseDown={(e) => { e.preventDefault(); choose(o); }}
                onMouseEnter={() => setHighlight(i)}
                style={{
                  padding: "8px 12px", fontSize: 13, cursor: "pointer",
                  background: i === highlight ? "rgba(59,130,246,0.18)" : "transparent",
                  color: o.groupId === Number(value) ? "#60a5fa" : "inherit",
                }}
              >
                {o.label}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

const SCREENSHOT_TYPES = ["image/png", "image/jpeg", "image/webp"];
const SCREENSHOT_MAX_MB = 8;

const TRACKING_MODES = [
  { value: "after_message_sent", label: "After route message is sent (default)" },
  { value: "immediate", label: "Immediately" },
  { value: "scheduled_time", label: "At a scheduled time" },
  { value: "start_location", label: "When the truck reaches a start location" },
];

function AssignForm({ options, onAssigned, onMessage }) {
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
    if (!SCREENSHOT_TYPES.includes(file.type)) {
      onMessage({ type: "error", text: `Screenshot must be PNG, JPG or WEBP (got ${file.type || "unknown type"}).` });
      return;
    }
    if (file.size > SCREENSHOT_MAX_MB * 1024 * 1024) {
      onMessage({ type: "error", text: `Screenshot is too large (${(file.size / 1048576).toFixed(1)} MB). The limit is ${SCREENSHOT_MAX_MB} MB.` });
      return;
    }
    setScreenshot(file);
    setScreenshotPreview((prev) => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(file); });
  }, [onMessage]);

  // Ctrl+V anywhere on the page attaches a pasted image as the route screenshot.
  useEffect(() => {
    const onPaste = (e) => {
      const items = e.clipboardData?.items || [];
      for (const item of items) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) { acceptScreenshot(file); e.preventDefault(); }
          return;
        }
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [acceptScreenshot]);

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

  /** Report the outcome, distinguishing full success from partial (send failed). */
  const reportResult = (result) => {
    const trackingNote = result.trackingStatus === "pending"
      ? " Tracking is pending until its start condition is met."
      : " Monitoring is active.";
    const base = result.geometryPending
      ? "Route saved. Geometry is pending — enable Google Maps in Settings → GMaps, then Compute."
      : `Route assigned and geometry computed.${trackingNote}`;
    if (result.driverMessage && result.driverMessage.sent === false) {
      onMessage({
        type: "warning",
        text: `${base} However, the route message could NOT be sent to the driver group: `
          + `${result.driverMessage.error || "unknown error"}. Use “Send route message” on the route below to retry.`,
      });
    } else if (result.driverMessage && result.driverMessage.sent) {
      onMessage({ type: "success", text: `${base} Route message sent to the driver group.` });
    } else {
      onMessage({ type: "success", text: base });
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
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); acceptScreenshot(e.dataTransfer?.files?.[0]); }}
          style={{
            border: `1.5px dashed ${dragOver ? "#60a5fa" : "rgba(148,163,184,0.4)"}`,
            borderRadius: 8, padding: screenshotPreview ? 8 : 18, cursor: "pointer",
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

/** Human label + colour for the tracking state shown in the route list. */
function trackingBadge(a) {
  if (a.status !== "active") return null;
  if (a.tracking_status !== "pending") return { text: "Tracking: Active", color: "#22c55e" };
  const hold = a.tracking_hold_reason
    || (a.tracking_start_mode === "after_message_sent" ? "waiting_for_message"
      : a.tracking_start_mode === "scheduled_time" ? "waiting_for_time"
        : a.tracking_start_mode === "start_location" ? "waiting_for_location" : null);
  switch (hold) {
    case "waiting_for_message":
      return { text: "Tracking: Waiting for route message", color: "#f59e0b" };
    case "waiting_for_time":
      return { text: `Tracking: Starts ${fmtTime(a.tracking_start_at)}`, color: "#f59e0b" };
    case "waiting_for_location":
      return {
        text: `Tracking: Waiting for truck to reach start location${a.tracking_start_radius_miles ? ` (${a.tracking_start_radius_miles} mi radius)` : ""}`,
        color: "#f59e0b",
      };
    default:
      return { text: "Tracking: Pending", color: "#f59e0b" };
  }
}

function RouteRow({ a, onChanged, onMessage }) {
  const [busy, setBusy] = useState(false);
  const [details, setDetails] = useState(null);

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
      onMessage({ type: "success", text: `Route message sent to the driver group.${tagged}${extras}` });
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

  const result = RESULT_LABELS[a.last_check_result] || { text: a.last_check_result || "—", color: "#94a3b8" };
  const statusBadge = a.status === "active" ? "badge-active" : "badge-inactive";
  const tracking = trackingBadge(a);

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
          {a.has_screenshot && <span className="badge" style={{ marginLeft: 6 }}>📷 screenshot</span>}
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
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "flex-start" }}>
          <button className="btn btn-ghost btn-sm" onClick={viewDetails}>{details ? "Hide" : "Details"}</button>
          {a.status === "active" && (
            <button className="btn btn-ghost btn-sm" onClick={sendRouteMessage} disabled={busy}>
              {a.driver_group_message_sent_at ? "Re-send route message" : "Send route message"}
            </button>
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
            <>
              <button className="btn btn-ghost btn-sm" onClick={() => act(() => api.completeRoute(a.id), "Route completed.")} disabled={busy}>Complete</button>
              <button className="btn btn-danger btn-sm" onClick={() => act(() => api.cancelRoute(a.id), "Route cancelled.")} disabled={busy}>Cancel</button>
            </>
          )}
        </div>
      </div>
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

export default function RouteControlPage() {
  const [options, setOptions] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [statusFilter, setStatusFilter] = useState("active");
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState(null);

  const loadAssignments = useCallback(async () => {
    setAssignments(await api.getRouteAssignments(statusFilter === "all" ? undefined : statusFilter));
  }, [statusFilter]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Driver profiles carry unit/name/type so the group picker is searchable.
      const profiles = await api.getDriverProfiles({ includeInactive: false });
      setOptions(buildGroupOptions(profiles));
      await loadAssignments();
    } catch (err) { setMessage({ type: "error", text: err.message }); }
    finally { setLoading(false); }
  }, [loadAssignments]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadAssignments().catch(() => {}); }, [statusFilter, loadAssignments]);

  return (
    <div>
      <div className="page-header">
        <h2>🧭 Route Control</h2>
        <p>Assign a planned Google Maps route to a driver, push it into their Telegram group, and get warned in that group if they go off route.</p>
      </div>
      <Banner message={message} />
      {loading ? (
        <div className="loading"><div className="spinner"></div> Loading…</div>
      ) : (
        <>
          <AssignForm options={options} onAssigned={loadAssignments} onMessage={setMessage} />
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            {["active", "completed", "cancelled", "all"].map((s) => (
              <button key={s} className={`btn btn-sm ${statusFilter === s ? "btn-primary" : "btn-ghost"}`} onClick={() => setStatusFilter(s)}>
                {s[0].toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
          {assignments.length === 0 ? (
            <div className="card"><div style={{ fontSize: 13, color: "#94a3b8" }}>No routes {statusFilter === "all" ? "" : statusFilter}.</div></div>
          ) : (
            assignments.map((a) => <RouteRow key={a.id} a={a} onChanged={loadAssignments} onMessage={setMessage} />)
          )}
        </>
      )}
    </div>
  );
}
