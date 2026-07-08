import React, { useCallback, useEffect, useState } from "react";
import * as api from "../api";

/**
 * Route Control — assign a Google Maps directions route to a driver group and
 * watch whether the driver follows it. Routes are monitored server-side against
 * the driver's live GPS; the driver group is warned when they drift off route.
 * Google Maps must be configured in Settings → GMaps for geometry to compute and
 * monitoring to run.
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
  return <div className={`alert alert-${message.type === "error" ? "error" : "success"}`}>{message.text}</div>;
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

function AssignForm({ groups, onAssigned, onMessage }) {
  const [groupId, setGroupId] = useState("");
  const [url, setUrl] = useState("");
  const [origin, setOrigin] = useState("");
  const [destination, setDestination] = useState("");
  const [waypoints, setWaypoints] = useState("");
  const [parsed, setParsed] = useState(null);
  const [busy, setBusy] = useState(false);

  const resetInputs = () => {
    setUrl(""); setOrigin(""); setDestination(""); setWaypoints(""); setParsed(null);
  };

  const testParse = async () => {
    setBusy(true); setParsed(null);
    try {
      const result = await api.parseRouteLink(url.trim());
      setParsed(result);
      onMessage({ type: "success", text: "Link parsed. Review the origin/destination below, then assign." });
    } catch (err) {
      // Surface the exact backend message and point at the manual fallback.
      onMessage({
        type: "error",
        text: `${err.message} You can also enter Origin and Destination below and assign manually.`,
      });
    } finally { setBusy(false); }
  };

  const assign = async () => {
    if (!groupId) { onMessage({ type: "error", text: "Pick a driver group." }); return; }
    const hasManual = origin.trim() && destination.trim();
    if (!url.trim() && !hasManual) {
      onMessage({ type: "error", text: "Paste a Google Maps directions link, or enter Origin and Destination." });
      return;
    }
    setBusy(true);
    try {
      let result;
      // Prefer a link that actually parses; otherwise fall back to manual entry.
      if (url.trim() && !hasManual) {
        result = await api.assignRoute({ groupId: Number(groupId), url: url.trim() });
      } else if (!url.trim() && hasManual) {
        result = await api.assignRoute({
          groupId: Number(groupId),
          manual: { origin: origin.trim(), destination: destination.trim(), waypoints: parseWaypoints(waypoints) },
        });
      } else {
        // Both provided: try the link first, fall back to manual on a parse failure.
        try {
          result = await api.assignRoute({ groupId: Number(groupId), url: url.trim() });
        } catch (linkErr) {
          onMessage({ type: "error", text: `${linkErr.message} Falling back to the Origin/Destination you entered…` });
          result = await api.assignRoute({
            groupId: Number(groupId),
            url: url.trim(),
            manual: { origin: origin.trim(), destination: destination.trim(), waypoints: parseWaypoints(waypoints) },
          });
        }
      }
      resetInputs();
      onMessage({
        type: "success",
        text: result.geometryPending
          ? "Route saved. Geometry is pending — enable Google Maps in Settings → GMaps, then Compute."
          : "Route assigned and geometry computed. Monitoring is active.",
      });
      await onAssigned();
    } catch (err) { onMessage({ type: "error", text: err.message }); }
    finally { setBusy(false); }
  };

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <h3 style={{ marginTop: 0 }}>➕ Assign a route</h3>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
        <div className="form-group" style={{ marginBottom: 0, minWidth: 220 }}>
          <label style={{ display: "block", fontSize: 12, marginBottom: 4 }}>Driver group</label>
          <select className="form-input" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            <option value="">Select a group…</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.group_name}</option>)}
          </select>
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

function RouteRow({ a, onChanged, onMessage }) {
  const [busy, setBusy] = useState(false);
  const [details, setDetails] = useState(null);

  const act = async (fn, okText) => {
    setBusy(true);
    try { await fn(); onMessage({ type: "success", text: okText }); await onChanged(); }
    catch (err) { onMessage({ type: "error", text: err.message }); }
    finally { setBusy(false); }
  };

  const viewDetails = async () => {
    if (details) { setDetails(null); return; }
    try { setDetails(await api.getRouteAssignment(a.id)); }
    catch (err) { onMessage({ type: "error", text: err.message }); }
  };

  const result = RESULT_LABELS[a.last_check_result] || { text: a.last_check_result || "—", color: "#94a3b8" };
  const statusBadge = a.status === "active" ? "badge-active" : "badge-inactive";

  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div>
          <strong>{a.driver_label || a.group_name || `Group ${a.group_id}`}</strong>
          {a.unit_number && <span style={{ color: "#94a3b8", marginLeft: 8, fontFamily: "monospace" }}>Unit {a.unit_number}</span>}
          <span className={`badge ${statusBadge}`} style={{ marginLeft: 8 }}>{a.status}</span>
          {!a.encoded_polyline && <span className="badge badge-inactive" style={{ marginLeft: 6 }}>geometry pending</span>}
          {a.source === "telegram" && <span className="badge" style={{ marginLeft: 6 }}>📲 from Telegram</span>}
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
          <div style={{ fontSize: 12, marginTop: 4 }}>
            Last check: <span style={{ color: result.color }}>{result.text}</span>
            {" · "}Deviation: {fmtMeters(a.last_deviation_meters)}
            {" · "}Checked: {fmtTime(a.last_checked_at)}
            {a.last_notification_at && <> · Last warning: {fmtTime(a.last_notification_at)}</>}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "flex-start" }}>
          <button className="btn btn-ghost btn-sm" onClick={viewDetails}>{details ? "Hide" : "Details"}</button>
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
  const [groups, setGroups] = useState([]);
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
      const [g] = await Promise.all([api.getDriverGroups()]);
      setGroups(Array.isArray(g) ? g : (g.groups || []));
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
        <p>Assign a planned Google Maps route to a driver and get warned in their group if they go off route.</p>
      </div>
      <Banner message={message} />
      {loading ? (
        <div className="loading"><div className="spinner"></div> Loading…</div>
      ) : (
        <>
          <AssignForm groups={groups} onAssigned={loadAssignments} onMessage={setMessage} />
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
