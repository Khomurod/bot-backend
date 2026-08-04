/** The event history table. */

import React, { useEffect, useState, useCallback } from "react";
import * as api from "../../api";
import { fmtTime } from "./trackingChrome";

function EventsTab({ flash, onOpen }) {
  const [events, setEvents] = useState([]);
  const [type, setType] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try { const d = await api.getTrailerEvents({ event_type: type || undefined }); setEvents(d.events || []); }
    catch (err) { flash("error", err.message); }
    finally { setLoading(false); }
  }, [type, flash]);
  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <select className="form-input" style={{ maxWidth: 180 }} value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All event types</option>
          <option value="pickup">Pickup</option>
          <option value="dropoff">Drop-off</option>
          <option value="mention_only">Mention only</option>
          <option value="unidentified">Unidentified</option>
        </select>
        <button className="btn" onClick={load}>Refresh</button>
      </div>
      {loading ? <p>Loading…</p> : (
        <div style={{ overflowX: "auto" }}>
          <table className="data-table">
            <thead><tr><th>When</th><th>Type</th><th>Review</th><th>Unit</th><th>Group</th><th>Driver</th><th>Location</th><th>Condition</th><th>Reporter</th><th>Conf</th><th></th></tr></thead>
            <tbody>
              {events.length === 0 && <tr><td colSpan={11} style={{ color: "#94a3b8" }}>No events.</td></tr>}
              {events.map((e) => (
                <tr key={e.id}>
                  <td>{fmtTime(e.event_time || e.created_at)}</td>
                  <td>{e.event_type}</td>
                  <td>{e.review_status || "—"}</td>
                  <td><strong>{e.trailer_unit_number || "—"}</strong></td>
                  <td>{e.telegram_group_name || "—"}</td>
                  <td>{e.driver_name || "—"}</td>
                  <td>{e.location_text || (e.location_missing ? "(missing)" : "—")}</td>
                  <td>{e.condition_text || "—"}</td>
                  <td>{e.reported_by_name || e.reported_by_username || "—"}</td>
                  <td>{e.confidence != null ? `${e.confidence}%` : "—"}</td>
                  <td>{e.trailer_id ? <button className="btn" onClick={() => onOpen(e.trailer_id)}>Open</button> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}


export default EventsTab;
