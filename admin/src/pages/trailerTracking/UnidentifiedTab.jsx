/** Sightings whose unit could not be resolved, and resolving them. */

import React, { useEffect, useState, useCallback } from "react";
import * as api from "../../api";
import { fmtTime } from "./trackingChrome";

function UnidentifiedTab({ flash }) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try { const d = await api.getTrailerUnidentified(false); setEvents(d.events || []); }
    catch (err) { flash("error", err.message); }
    finally { setLoading(false); }
  }, [flash]);
  useEffect(() => { load(); }, [load]);

  const resolve = async (id) => {
    try { await api.resolveTrailerUnidentified(id); flash("success", "Marked resolved."); load(); }
    catch (err) { flash("error", err.message); }
  };

  return (
    <div>
      <button className="btn" onClick={load} style={{ marginBottom: 12 }}>Refresh</button>
      {loading ? <p>Loading…</p> : (
        <div style={{ overflowX: "auto" }}>
          <table className="data-table">
            <thead><tr><th>When</th><th>Group</th><th>Reporter</th><th>Unit</th><th>Reason</th><th>Message</th><th></th></tr></thead>
            <tbody>
              {events.length === 0 && <tr><td colSpan={7} style={{ color: "#94a3b8" }}>Nothing to review 🎉</td></tr>}
              {events.map((e) => (
                <tr key={e.id}>
                  <td>{fmtTime(e.created_at)}</td>
                  <td>{e.telegram_group_name || "—"}</td>
                  <td>{e.reported_by_name || e.reported_by_username || "—"}</td>
                  <td>{e.trailer_unit_number || "—"}</td>
                  <td>{e.unidentified_reason || e.event_type}</td>
                  <td style={{ maxWidth: 320, whiteSpace: "pre-wrap" }}>{e.raw_message_text || "—"}</td>
                  <td><button className="btn" onClick={() => resolve(e.id)}>Resolve</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}


export default UnidentifiedTab;
