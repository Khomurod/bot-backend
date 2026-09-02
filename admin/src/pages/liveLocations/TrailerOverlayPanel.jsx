import React from "react";
import { displayTrailerStatus } from "../../utils/trailerState";

/**
 * The trailer overlay controls: asset-view toggle, status/cargo filters, the
 * snapshot counts, the legend, and the trailers that have no mappable position.
 *
 * The no-position list exists so a trailer is never silently absent: one with
 * no GPS and no driver to derive from still appears here as text, which is how
 * a dispatcher notices it needs attention rather than assuming it is gone.
 *
 * Split out of admin/src/pages/LiveLocationsPage.jsx.
 */
export function TrailerOverlayPanel({
  assetFilters, setAssetFilter, trailerCounts,
  visibleTrailers, mappableTrailers, trailerTextOnly, showTrailers, trailers,
}) {
  return (
    <>
  {/* Trailer overlay: filters, snapshot counts, legend, and the filtered
      trailer list (mappable + list-only). The list uses EXACTLY the same
      filtered dataset as the markers. */}
  {showTrailers && trailers.length > 0 && (
    <div className="card" style={{ padding: 12, marginTop: 16 }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", fontSize: 12, marginBottom: 8 }} role="group" aria-label="Trailer filters">
        <strong>Trailers — showing {visibleTrailers.length} of {trailerCounts.trailers}</strong>
        {[
          ["trailerPossession", "Possession", [["all", "All"], ["with_driver", "With driver"], ["dropped", "Dropped"], ["unknown", "Unknown"]]],
          ["trailerCargo", "Cargo", [["all", "All"], ["loaded", "Loaded"], ["empty", "Empty"], ["unknown", "Unknown cargo"]]],
          ["trailerReview", "Review", [["all", "All"], ["needs_review", "Needs review"], ["confirmed", "Confirmed"]]],
          ["locationQuality", "Location", [["all", "All"], ["exact", "Exact / manual"], ["derived_from_driver", "Derived"], ["approximate", "Approximate"], ["missing", "Missing"]]],
        ].map(([key, label, options]) => (
          <label key={key} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            {label}
            <select className="form-input" style={{ height: 28, padding: "2px 6px", fontSize: 12, width: "auto" }}
              value={assetFilters[key]} onChange={(e) => setAssetFilter({ [key]: e.target.value })}
              aria-label={`Trailer filter: ${label}`}>
              {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
        ))}
        <button className="btn btn-ghost btn-sm" style={{ fontSize: 12 }}
          onClick={() => setAssetFilter({ trailerPossession: "all", trailerCargo: "all", trailerReview: "all", locationQuality: "all" })}
          aria-label="Clear trailer filters">
          ✕ Clear
        </button>
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", fontSize: 12, marginBottom: 8, color: "var(--text-muted)" }} aria-label="Trailer snapshot counts">
        {[
          ["With driver", trailerCounts.withDriver], ["Dropped", trailerCounts.dropped],
          ["Loaded", trailerCounts.loaded], ["Empty", trailerCounts.empty],
          ["Unknown cargo", trailerCounts.unknownCargo], ["Needs review", trailerCounts.needsReview],
          ["No location", trailerCounts.locationMissing],
        ].map(([l, v]) => <span key={l}>{l} <strong>{v}</strong></span>)}
        <span style={{ fontSize: 11 }}>(full snapshot, before filters)</span>
      </div>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center", fontSize: 12 }}>
        {[
          { c: "#f59e0b", l: "Dropped / Empty (E)" },
          { c: "#a855f7", l: "Dropped / Loaded (L)" },
          { c: "#22c55e", l: "With driver / Empty (E)" },
          { c: "#8b5cf6", l: "With driver / Loaded (L)" },
          { c: "#3b82f6", l: "With driver / Unknown (?)" },
        ].map((s) => (
          <span key={s.l} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 15, height: 11, borderRadius: 2, background: s.c, border: "2px solid #fff", display: "inline-block" }} />
            {s.l}
          </span>
        ))}
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 15, height: 11, borderRadius: 2, border: "2px solid #ef4444", display: "inline-block" }} /> Needs review (!)
        </span>
        <span>Letter inside the rectangle = cargo state (never color-only).</span>
      </div>
      {trailerTextOnly.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>
            Matching trailers with no mappable location ({trailerTextOnly.length}) — list-only, no marker:
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
            {trailerTextOnly.map((e) => (
              <li key={e.trailer.trailer_id}>
                <strong>{e.trailer.unit_number}</strong> — {e.trailer.location_text || "(unknown)"} ({displayTrailerStatus(e.trailer)})
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )}
    </>
  );
}
