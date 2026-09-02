import React from "react";
import { timeAgo } from "../../utils/formatTime";
import { FILTERS, statusColor, fmtEta } from "./constants";

/**
 * The map pane and the unit side panel, side by side.
 *
 * The MAP CONTAINER IS ALWAYS RENDERED, even while the snapshot is loading or
 * failed — Leaflet needs a sized element to initialize into, and the map is
 * still useful with stale markers on it.
 *
 * The panel and the map read the same filtered dataset, so a unit shown in one
 * is always present in the other.
 *
 * Split out of admin/src/pages/LiveLocationsPage.jsx.
 */
export function MapAndUnitList({
  mapContainerRef, mapError, tileError, mapReady,
  filtered, units, selectedUnit, selectUnit, fitAll,
  search, setSearch, filter, setFilter,
  loading, snapshot, trailerTextOnly, showTrailers,
}) {
  return (
    <>
  {/* The map + unit list always render. The map initializes independently of
      GPS/load data, so it loads (centered on the US) even with zero markers.
      Only a true Leaflet failure shows a "map unavailable" message. */}
  {(
    <div style={{ display: "flex", gap: 16, alignItems: "stretch", flexWrap: "wrap" }}>
      {/* Map — responsive height (fills the viewport, min 460px) so it is
          never shrunk; invalidateSize on mount/resize keeps tiles correct. */}
      <div className="card" style={{ flex: "1 1 520px", minWidth: 320, padding: 0, overflow: "hidden", position: "relative" }}>
        <div ref={mapContainerRef} style={{ height: "max(460px, calc(100vh - 300px))", width: "100%", background: "var(--bg-secondary)" }} />
        {tileError && mapReady && (
          <div style={{ position: "absolute", top: 8, left: 8, right: 8, zIndex: 500, background: "rgba(245,158,11,0.95)", color: "#1e293b", padding: "6px 10px", borderRadius: 6, fontSize: 12, fontWeight: 600 }}>
            ⚠️ Map tiles failed to load (tile provider unreachable). The map and unit list still work.
          </div>
        )}
        {mapError && (
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", padding: 16, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
            <div>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>Map failed to initialize</div>
              <div style={{ marginBottom: 6 }}>{mapError}</div>
              <div>The unit list is still usable →</div>
            </div>
          </div>
        )}
        {!mapReady && !mapError && (
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", pointerEvents: "none", color: "var(--text-muted)", fontSize: 13 }}>
            <div><div className="spinner" style={{ margin: "0 auto 8px" }}></div>Loading map…</div>
          </div>
        )}
        {loading && mapReady && (
          <div style={{ position: "absolute", top: 8, right: 8, zIndex: 500, background: "var(--bg-secondary)", padding: "4px 8px", borderRadius: 6, fontSize: 11, color: "var(--text-muted)" }}>
            Refreshing…
          </div>
        )}
      </div>

      {/* Side panel */}
      <div className="card" style={{ flex: "0 1 360px", minWidth: 280, display: "flex", flexDirection: "column", maxHeight: "max(460px, calc(100vh - 300px))" }}>
        <input
          className="form-input"
          placeholder="Search by unit or driver…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ marginBottom: 10 }}
        />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
          {FILTERS.map((f) => (
            <button
              key={f.key}
              className={`btn btn-sm ${filter === f.key ? "btn-primary" : "btn-ghost"}`}
              style={{ fontSize: 12 }}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div style={{ overflowY: "auto", flex: 1, margin: "0 -8px" }}>
          {filtered.length === 0 ? (
            <div className="empty-state" style={{ padding: 20 }}>
              {loading && !snapshot ? (
                <><div className="spinner"></div><p>Loading live locations…</p></>
              ) : (
                <><div className="icon">📭</div><p>No units match.</p></>
              )}
            </div>
          ) : filtered.map((u) => (
            <button
              key={u.unit}
              onClick={() => selectUnit(u)}
              style={{
                display: "block", width: "100%", textAlign: "left", cursor: "pointer",
                padding: "10px 12px", border: "none", borderBottom: "1px solid var(--border)",
                background: u.unit === selectedUnit ? "var(--bg-secondary)" : "transparent",
                borderLeft: `4px solid ${statusColor(u)}`,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                <span style={{ fontWeight: 700 }}>#{u.unit}</span>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  {u.provider ? (PROVIDER_LABEL[u.provider] || u.provider) : "no GPS"}
                </span>
              </div>
              <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>{u.driverName || u.groupName || "—"}</div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
                {u.location
                  ? `${u.location.speedMph != null ? u.location.speedMph + " mph · " : ""}${u.location.lastUpdated ? timeAgo(u.location.lastUpdated) : "—"}`
                  : "no GPS"}
              </div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
                {u.load
                  ? `${u.load.loadId || "load"}${u.load.nextStopType ? " · next " + u.load.nextStopType : ""} · ${fmtEta(u.eta)}`
                  : "no active load"}
              </div>
              {u.warnings && u.warnings.length > 0 && (
                <div style={{ fontSize: 11, color: "#f59e0b", marginTop: 2 }} title={u.matchWarning || undefined}>
                  ⚠ {u.warnings.map((w) => w.replace(/_/g, " ")).join(", ")}
                </div>
              )}
              {u.matchWarning && (
                <div style={{ fontSize: 11, color: "#f87171", marginTop: 2 }}>{u.matchWarning}</div>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  )}
    </>
  );
}
