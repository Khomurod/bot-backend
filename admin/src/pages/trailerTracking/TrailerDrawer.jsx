/** The trailer detail drawer: status, timeline, and the two edit forms. */

import React, { useEffect, useState, useCallback } from "react";
import * as api from "../../api";
import { displayTrailerStatus, possessionStatusLabel, cargoStatusLabel } from "../../utils/trailerState";
import { fmtTime, StatusBadge } from "./trackingChrome";
import EventEditForm from "./EventEditForm";
import TrailerEditForm from "./TrailerEditForm";

function TrailerDrawer({ id, onClose, flash, onChanged }) {
  const [data, setData] = useState(null); // { trailer, status, review }
  const [timeline, setTimeline] = useState([]);
  const [editingTrailer, setEditingTrailer] = useState(false);
  const [editingEvent, setEditingEvent] = useState(null); // event object being edited
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api.getTrailer(id);
      setData({ trailer: d.trailer, status: d.status, review: d.review || {} });
      const t = await api.getTrailerTimeline(id);
      setTimeline(t.events || []);
    } catch (err) { flash("error", err.message); }
  }, [id, flash]);

  useEffect(() => { load(); }, [load]);

  const afterChange = useCallback(async () => {
    setEditingTrailer(false);
    setEditingEvent(null);
    await load();
    if (onChanged) onChanged();
  }, [load, onChanged]);

  const accept = async (eventId) => {
    setBusy(true);
    try { await api.acceptTrailerEvent(eventId); flash("success", "Change accepted."); await afterChange(); }
    catch (err) { flash("error", err.message); }
    finally { setBusy(false); }
  };
  const decline = async (eventId) => {
    setBusy(true);
    try { await api.declineTrailerEvent(eventId); flash("success", "Change declined; previous status restored."); await afterChange(); }
    catch (err) { flash("error", err.message); }
    finally { setBusy(false); }
  };

  if (!data) return null;
  const { trailer, status, review } = data;
  const pending = review && review.pendingEvent;
  const previous = review && review.previousEvent;

  return (
    <div style={{ position: "fixed", top: 0, right: 0, bottom: 0, width: "min(600px, 100%)", background: "var(--bg, #0f172a)", boxShadow: "-4px 0 20px rgba(0,0,0,.4)", zIndex: 1000, overflowY: "auto", padding: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0 }}>Trailer {trailer.unit_number}</h2>
        <button className="btn" onClick={onClose}>Close</button>
      </div>
      <div style={{ margin: "8px 0", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <StatusBadge status={status?.possession_status || status?.current_status} needsReview={!!(status?.needs_review || trailer.needs_review)} label={status ? displayTrailerStatus(status) : undefined} />
        <span style={{ fontSize: 12, color: "#94a3b8" }}>
          Possession: {possessionStatusLabel(status?.possession_status || status?.current_status)} · Cargo: {cargoStatusLabel(status?.cargo_status)}
        </span>
      </div>

      {/* ── Review panel: latest detected change awaiting a decision ── */}
      {pending && !editingEvent && (
        <div className="card" style={{ padding: 14, marginBottom: 12, border: "1px solid #ef444455", background: "#ef44440d" }}>
          <h4 style={{ marginTop: 0, color: "#ef4444" }}>Detected change needs review</h4>
          <div style={{ fontSize: 14, marginBottom: 6 }}>
            <div><strong>Detected:</strong> {pending.event_type} · {pending.location_text || "(no location)"} · {pending.condition_text || "—"}</div>
            <div style={{ color: "#94a3b8", fontSize: 12 }}>
              Reported by {pending.reported_by_name || pending.reported_by_username || "—"} · {fmtTime(pending.event_time || pending.created_at)}
            </div>
            <div style={{ marginTop: 6 }}>
              <span style={{ color: "#94a3b8" }}>Current confirmed status: </span>
              <StatusBadge status={status?.possession_status || status?.current_status} label={status ? displayTrailerStatus(status) : undefined} />
            </div>
            {previous && (
              <div style={{ marginTop: 4, fontSize: 12, color: "#94a3b8" }}>
                Previous confirmed: {previous.event_type} · {previous.location_text || "—"} · {fmtTime(previous.event_time || previous.created_at)}
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn btn-primary" onClick={() => accept(pending.id)} disabled={busy}>Accept</button>
            <button className="btn" style={{ borderColor: "#ef4444", color: "#ef4444" }} onClick={() => decline(pending.id)} disabled={busy}>Decline the change</button>
            <button className="btn" onClick={() => setEditingEvent(pending)} disabled={busy}>Edit the change</button>
          </div>
        </div>
      )}

      {editingEvent && (
        <EventEditForm event={editingEvent} flash={flash} onSaved={afterChange} onCancel={() => setEditingEvent(null)} />
      )}

      {/* ── Trailer details (view / edit) ── */}
      {editingTrailer ? (
        <TrailerEditForm trailer={trailer} flash={flash} onSaved={afterChange} onCancel={() => setEditingTrailer(false)} />
      ) : (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h3 style={{ margin: "8px 0" }}>Details</h3>
            <button className="btn" onClick={() => setEditingTrailer(true)}>Edit details</button>
          </div>
          <table className="data-table" style={{ marginBottom: 16 }}>
            <tbody>
              <tr><td>Make</td><td>{trailer.make || "—"}</td></tr>
              <tr><td>Model</td><td>{trailer.model || "—"}</td></tr>
              <tr><td>MC #</td><td>{trailer.mc_number || "—"}</td></tr>
              <tr><td>Plate</td><td>{trailer.plate_number || "—"}</td></tr>
              <tr><td>VIN</td><td>{trailer.vin || "—"}</td></tr>
              <tr><td>Type</td><td>{trailer.type || "—"}</td></tr>
              <tr><td>Year</td><td>{trailer.year || "—"}</td></tr>
              <tr><td>Ownership</td><td>{trailer.ownership_status || "—"}</td></tr>
              <tr><td>Active</td><td>{trailer.active === false ? "No" : "Yes"}</td></tr>
              <tr><td>Current driver</td><td>{status?.current_driver_name || "—"}</td></tr>
              <tr><td>Current location</td><td>{status?.current_location_text || "—"}{status?.location_source ? ` (${status.location_source})` : ""}</td></tr>
              <tr><td>Last reporter</td><td>{status?.last_reporter_name || "—"}</td></tr>
            </tbody>
          </table>
        </>
      )}

      <h3>Event timeline</h3>
      <div style={{ overflowX: "auto" }}>
        <table className="data-table">
          <thead><tr><th>When</th><th>Type</th><th>Review</th><th>Location</th><th>Condition</th><th>Reporter</th><th></th></tr></thead>
          <tbody>
            {timeline.length === 0 && <tr><td colSpan={7} style={{ color: "#94a3b8" }}>No events.</td></tr>}
            {timeline.map((e) => (
              <tr key={e.id} style={e.review_status === "declined" ? { opacity: 0.55 } : undefined}>
                <td>{fmtTime(e.event_time || e.created_at)}</td>
                <td>{e.event_type}</td>
                <td>{e.review_status || "—"}</td>
                <td>{e.location_text || "—"}</td>
                <td>{e.condition_text || "—"}</td>
                <td>{e.reported_by_name || e.reported_by_username || "—"}</td>
                <td>
                  {(e.event_type === "pickup" || e.event_type === "dropoff") && (
                    <button className="btn" onClick={() => setEditingEvent(e)}>Edit</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}


export default TrailerDrawer;
