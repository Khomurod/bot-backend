/** The trailer list: filters, the table, and opening the detail drawer. */

import React, { useEffect, useState, useCallback } from "react";
import * as api from "../../api";
import { displayTrailerStatus, possessionStatusLabel, cargoStatusLabel } from "../../utils/trailerState";
import { fmtTime, StatusBadge, ReviewPill } from "./trackingChrome";

function TrailerListTab({ onOpen, flash, reloadKey }) {
  const [trailers, setTrailers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ q: "", status: "", needs_review: false });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getTrailers({
        q: filters.q || undefined,
        status: filters.status || undefined,
        needs_review: filters.needs_review ? "true" : undefined,
      });
      setTrailers(data.trailers || []);
    } catch (err) {
      flash("error", err.message);
    } finally {
      setLoading(false);
    }
  }, [filters, flash]);

  useEffect(() => { load(); }, [load, reloadKey]);

  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <input
          className="form-input" placeholder="Search unit / plate / VIN" style={{ maxWidth: 240 }}
          value={filters.q} onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
        />
        <select className="form-input" style={{ maxWidth: 160 }}
          value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}>
          <option value="">All statuses</option>
          <option value="with_driver">With driver</option>
          <option value="dropped">Dropped</option>
          <option value="unknown">Unknown</option>
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={filters.needs_review}
            onChange={(e) => setFilters((f) => ({ ...f, needs_review: e.target.checked }))} />
          Needs review
        </label>
        <button className="btn" onClick={load}>Refresh</button>
      </div>
      {loading ? <p>Loading…</p> : (
        <div style={{ overflowX: "auto" }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Unit</th><th>Display Status</th><th>Possession</th><th>Cargo</th><th>Current Driver</th><th>Location</th>
                <th>Last Condition</th><th>Last Event</th><th>Plate</th><th>VIN</th>
                <th>Type</th><th>Ownership</th><th>Last Reporter</th><th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {trailers.length === 0 && (
                <tr><td colSpan={14} style={{ textAlign: "center", color: "#94a3b8" }}>No trailers yet.</td></tr>
              )}
              {trailers.map((t) => {
                const needsReview = !!(t.status_needs_review || t.needs_review);
                return (
                  <tr key={t.id} style={{ cursor: "pointer" }} onClick={() => onOpen(t.id)}>
                    <td><strong>{t.unit_number}</strong></td>
                    <td>
                      <StatusBadge status={t.possession_status || t.current_status} needsReview={needsReview} label={displayTrailerStatus(t)} />
                      {t.status_needs_review ? <ReviewPill /> : null}
                    </td>
                    <td>{possessionStatusLabel(t.possession_status || t.current_status)}</td>
                    <td>{cargoStatusLabel(t.cargo_status)}</td>
                    <td>{t.current_driver_name || "—"}</td>
                    <td>{t.current_location_text || "—"}</td>
                    <td>{t.current_condition || "—"}</td>
                    <td>{t.last_event_type || "—"}</td>
                    <td>{t.plate_number || "—"}</td>
                    <td>{t.vin || "—"}</td>
                    <td>{t.type || "—"}</td>
                    <td>{t.ownership_status || "—"}</td>
                    <td>{t.last_reporter_name || "—"}</td>
                    <td>{fmtTime(t.last_event_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}


export default TrailerListTab;
