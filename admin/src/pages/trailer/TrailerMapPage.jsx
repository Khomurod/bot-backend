import React, { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import api from "../../api/trailerDepartment";
import { Card, Empty, Field, PageHeader, Status, useLoad, useUrlList } from "./TrailerUi";
import { filterMapRows, locationSourceLabel, hasLocation } from "./a11y/mapFilters";
import { trailerCondition } from "./trailerStatusVocabulary";

const CENTER = [39.5, -98.35];
const COLORS = {
  available: "#16a34a", rented: "#2563eb", maintenance: "#d97706", under_inspection: "#7c3aed",
  out_of_service: "#dc2626", held_damage: "#be123c", unknown: "#64748b",
};
const CONDITIONS = ["available", "rented", "under_inspection", "maintenance", "out_of_service", "held_damage", "unknown"];
const SOURCES = [["gps", "Trailer GPS"], ["manual", "Manual"], ["derived_from_driver", "Driver-derived"], ["unknown", "Unknown"]];
const INVOICE_STATUSES = ["issued", "partially_paid", "paid", "overdue", "disputed"];
const FILTER_KEYS = ["q", "condition", "company", "rental_state", "location_source", "invoice_status",
  "missing_location", "needs_attention", "outstanding_only", "return_before", "page", "page_size"];

const escape = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export default function TrailerMapPage() {
  const mapNode = useRef(null); const mapRef = useRef(null); const layerRef = useRef(null);
  const { filters, setFilter, clearAll, activeCount } = useUrlList(FILTER_KEYS);
  const [searchText, setSearchText] = useState(filters.q || "");
  useEffect(() => {
    const id = setTimeout(() => {
      if ((searchText || "") !== (filters.q || "")) setFilter({ q: searchText || undefined });
    }, 300);
    return () => clearTimeout(id);
  }, [searchText]);

  const { data, loading, error, reload } = useLoad(() => api.mapData(), []);
  const rows = filterMapRows(data?.trailers || [], filters);

  useEffect(() => {
    if (!mapNode.current || mapRef.current) return;
    mapRef.current = L.map(mapNode.current).setView(CENTER, 4);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap contributors" }).addTo(mapRef.current);
    layerRef.current = L.layerGroup().addTo(mapRef.current);
    return () => { mapRef.current?.remove(); mapRef.current = null; };
  }, []);

  useEffect(() => {
    const layer = layerRef.current; if (!layer) return;
    layer.clearLayers();
    const points = [];
    for (const row of rows) {
      if (!hasLocation(row)) continue;
      const lat = Number(row.current_lat); const lng = Number(row.current_lng);
      points.push([lat, lng]);
      L.circleMarker([lat, lng], { radius: 8, color: "#fff", weight: 2, fillColor: COLORS[row.physical_status] || COLORS.unknown, fillOpacity: 1 })
        .bindPopup(`<b>Trailer ${escape(row.unit_number)}</b><br>${escape(row.physical_status).replaceAll("_", " ")}<br>${escape(row.current_location_text || "Location unavailable")}<br><small>${escape(locationSourceLabel(row.location_source, true))}</small>`)
        .addTo(layer);
    }
    if (points.length && mapRef.current) mapRef.current.fitBounds(points, { padding: [24, 24], maxZoom: 12 });
  }, [rows]);

  return (
    <div>
      <PageHeader title="Trailer Map"
        subtitle="Trailer assets only. Driver-derived positions are labeled and are not live trailer GPS."
        actions={<button className="btn btn-secondary" onClick={reload}>Refresh</button>} />
      {error && <div className="alert alert-danger" role="alert">{error}</div>}

      {/* Collapsible on mobile via <details>; open by default. */}
      <details className="trailer-map-filters" open>
        <summary>Filters{activeCount ? ` (${activeCount})` : ""}</summary>
        <div className="trailer-filter-bar" role="search">
          <Field label="Search">
            <input type="search" value={searchText} aria-label="Search trailers on map"
              placeholder="Unit, renter, status or location"
              onChange={(e) => setSearchText(e.target.value)} />
          </Field>
          <Field label="Condition">
            <select value={filters.condition || ""} onChange={(e) => setFilter({ condition: e.target.value || undefined })}>
              <option value="">Any condition</option>
              {CONDITIONS.map((c) => <option key={c} value={c}>{trailerCondition(c).label}</option>)}
            </select>
          </Field>
          <Field label="Company">
            <input value={filters.company || ""} placeholder="Company name"
              onChange={(e) => setFilter({ company: e.target.value || undefined })} />
          </Field>
          <Field label="Rental state">
            <select value={filters.rental_state || ""} onChange={(e) => setFilter({ rental_state: e.target.value || undefined })}>
              <option value="">Any</option><option value="available">Available</option><option value="rented">Rented</option>
            </select>
          </Field>
          <Field label="Location source">
            <select value={filters.location_source || ""} onChange={(e) => setFilter({ location_source: e.target.value || undefined })}>
              <option value="">Any source</option>
              {SOURCES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
          <Field label="Invoice status">
            <select value={filters.invoice_status || ""} onChange={(e) => setFilter({ invoice_status: e.target.value || undefined })}>
              <option value="">Any invoice status</option>
              {INVOICE_STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
            </select>
          </Field>
          <Field label="Expected return before">
            <input type="date" value={filters.return_before || ""} onChange={(e) => setFilter({ return_before: e.target.value || undefined })} />
          </Field>
          <label className="trailer-check"><input type="checkbox"
            checked={filters.missing_location === "true" || filters.missing_location === true}
            onChange={(e) => setFilter({ missing_location: e.target.checked ? "true" : undefined })} /> Missing location</label>
          <label className="trailer-check"><input type="checkbox"
            checked={filters.needs_attention === "true" || filters.needs_attention === true}
            onChange={(e) => setFilter({ needs_attention: e.target.checked ? "true" : undefined })} /> Needs attention</label>
          <label className="trailer-check"><input type="checkbox"
            checked={filters.outstanding_only === "true" || filters.outstanding_only === true}
            onChange={(e) => setFilter({ outstanding_only: e.target.checked ? "true" : undefined })} /> Outstanding balance</label>
          {activeCount > 0 && (
            <button type="button" className="btn btn-ghost btn-sm"
              onClick={() => { setSearchText(""); clearAll(); }}>Clear all filters ({activeCount})</button>
          )}
        </div>
      </details>

      <div className="trailer-map-layout">
        <div ref={mapNode} className="trailer-map" role="application" aria-label="Trailer locations" />
        <Card className="trailer-map-list">
          <h3>Trailers ({rows.length})</h3>
          {loading ? <div className="loading" role="status">Loading…</div>
            : !rows.length ? <Empty>{activeCount > 0 ? "No trailers match these filters." : "No trailers to show."}</Empty>
              : rows.map((row) => (
                <div className="trailer-map-row" key={row.trailer_id || row.id}>
                  <b>{row.unit_number}</b>
                  <Status value={row.physical_status} />
                  <span>{row.current_location_text || "No coordinates"}</span>
                  <small>{locationSourceLabel(row.location_source, hasLocation(row))}</small>
                </div>
              ))}
        </Card>
      </div>
    </div>
  );
}
