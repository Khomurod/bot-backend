import React, { useMemo, useState } from "react";
import { timeAgo } from "../utils/formatTime";
import { clockTime, PROVIDER_LABEL } from "./liveLocations/constants";
import { useLiveSnapshot } from "./liveLocations/useLiveSnapshot";
import { useAssetFilters } from "./liveLocations/useAssetFilters";
import { useLeafletMap } from "./liveLocations/useLeafletMap";
import { DiagnosticsPanel } from "./liveLocations/DiagnosticsPanel";
import { MapAndUnitList } from "./liveLocations/MapAndUnitList";
import { TrailerOverlayPanel } from "./liveLocations/TrailerOverlayPanel";

/**
 * Live Locations — page container.
 *
 * LAYOUT AND WIRING ONLY:
 *
 *   ./liveLocations/constants.js       intervals, filter lists, pure formatters
 *   ./liveLocations/markers.js         Leaflet icons + escaped popup markup
 *   ./liveLocations/storedFilters.js   the per-browser overlay selection
 *   ./liveLocations/useLiveSnapshot.js the snapshot, trailers, auto-refresh
 *   ./liveLocations/useAssetFilters.js the filters + ONE shared trailer dataset
 *   ./liveLocations/useLeafletMap.js   the map's whole lifecycle and its layers
 *   ./liveLocations/{DiagnosticsPanel,MapAndUnitList,TrailerOverlayPanel}.jsx
 *
 * The three hooks are layered rather than merged: the snapshot knows nothing
 * about the map, the filters derive from the snapshot, and the map consumes the
 * filtered result. That order is why a provider failure degrades to a banner
 * over stale markers instead of an empty page.
 *
 * Truck search/status filtering stays here because BOTH the map and the side
 * panel read the same `filtered` array — computing it twice is how a unit ends
 * up listed but unmapped.
 */
export default function LiveLocationsPage() {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  const live = useLiveSnapshot();
  const {
    snapshot, loading, refreshing, error, lastUpdated, autoRefresh, setAutoRefresh,
    trailers, selectedUnit, setSelectedUnit, load, units, summary, providerErrors,
  } = live;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return units.filter((u) => {
      if (q) {
        const hay = `${u.unit || ""} ${u.driverName || ""} ${u.groupName || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      switch (filter) {
        case "active_load": return !!u.load;
        case "no_load": return !u.load;
        case "stale": return !!(u.location && u.location.isStale);
        case "samsara": return u.provider === "samsara";
        case "factor": return u.provider === "factor";
        case "leader": return u.provider === "leader";
        default: return true;
      }
    });
  }, [units, search, filter]);

  const assets = useAssetFilters({ units, trailers, search });
  const map = useLeafletMap({
    filtered, selectedUnit, setSelectedUnit,
    showTrucks: assets.showTrucks, showTrailers: assets.showTrailers,
    mappableTrailers: assets.mappableTrailers,
    showDiagnostics, error, snapshot, providerErrors,
  });

  const cards = summary ? [
    { label: "Units visible", value: filtered.length, color: "#6366f1" },
    { label: "Active loads", value: summary.activeLoads, color: "#22c55e" },
    { label: "Stale GPS", value: summary.staleGps, color: "#f59e0b" },
    { label: "No active load", value: summary.noActiveLoad, color: "#3b82f6" },
    { label: "Provider errors", value: summary.providerErrors, color: "#ef4444" },
  ] : [];

  return (
    <div>
      <div className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h2>📍 Live Locations</h2>
          <p>Current truck locations, active loads, and ETA to next pickup or delivery.</p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {refreshing && snapshot
              ? `Showing last updated data from ${clockTime(lastUpdated || Date.now())} — refreshing…`
              : refreshing
                ? "Refreshing…"
                : lastUpdated ? `Updated ${timeAgo(new Date(lastUpdated).toISOString())}` : ""}
          </span>
          <button className="btn btn-ghost btn-sm" onClick={() => load({ force: true })} disabled={refreshing}>🔄 Refresh</button>
          <button
            className={`btn btn-sm ${autoRefresh ? "btn-primary" : "btn-ghost"}`}
            onClick={() => setAutoRefresh((v) => !v)}
            title="Auto-refresh every 45s"
          >
            {autoRefresh ? "⏱ Auto: On" : "⏱ Auto: Off"}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={fitAll} title="Fit the map to the currently visible filtered markers">🗺 Fit visible</button>
          <div role="group" aria-label="Asset view" style={{ display: "inline-flex", gap: 4 }}>
            {[["all", "All assets"], ["trucks", "Trucks only"], ["trailers", "Trailers only"]].map(([v, l]) => (
              <button key={v}
                className={`btn btn-sm ${assetFilters.assetView === v ? "btn-primary" : "btn-ghost"}`}
                onClick={() => setAssetFilter({ assetView: v })}
                aria-pressed={assetFilters.assetView === v}
              >
                {l}
              </button>
            ))}
          </div>
          <button
            className={`btn btn-sm ${showDiagnostics ? "btn-primary" : "btn-ghost"}`}
            onClick={() => setShowDiagnostics((v) => !v)}
            title="Show provider/match/cache diagnostics"
          >
            🩺 Diagnostics
          </button>
        </div>
      </div>

      {/* A failed background refresh keeps the last good data on screen. */}
      {error && (
        <div className="alert alert-error" style={{ marginTop: 0 }}>
          ⚠️ {snapshot
            ? "Could not refresh live data. Showing last successful snapshot."
            : error}
        </div>
      )}
      {snapshot?.isStale && !error && (
        <div className="alert alert-error" style={{ marginTop: 0 }}>
          ⚠️ {snapshot.warning || "Live data source is temporarily unavailable — showing last successful snapshot."}
        </div>
      )}

      {showDiagnostics && <DiagnosticsPanel snapshot={snapshot} lastUpdated={lastUpdated} providerErrors={providerErrors} />}

      {/* Provider errors, shown SEPARATELY so a Factor/Leader/Datatruck failure
          never hides the providers (e.g. Samsara) that are working. */}
      {providerErrors.length > 0 && (
        <div className="alert alert-error" style={{ marginTop: 0 }}>
          <strong>Some providers had errors</strong> (other providers still work):
          <ul style={{ margin: "6px 0 0", paddingLeft: 20 }}>
            {providerErrors.map((e, i) => (
              <li key={i} style={{ fontSize: 13 }}>
                <strong>{PROVIDER_LABEL[e.provider] || e.provider}:</strong> {e.message || e.code || "error"}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Status cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 12, marginBottom: 16 }}>
        {cards.map((c) => (
          <div key={c.label} className="card" style={{ padding: "12px 16px" }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: c.color }}>{c.value}</div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.5px" }}>{c.label}</div>
          </div>
        ))}
      </div>

      <MapAndUnitList
        {...map}
        filtered={filtered}
        units={units}
        selectedUnit={selectedUnit}
        search={search}
        setSearch={setSearch}
        filter={filter}
        setFilter={setFilter}
        loading={loading}
        snapshot={snapshot}
        trailerTextOnly={assets.trailerTextOnly}
        showTrailers={assets.showTrailers}
      />

      <TrailerOverlayPanel {...assets} trailers={trailers} />
    </div>
  );
}
