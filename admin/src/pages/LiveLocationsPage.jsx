import React, { useMemo, useState } from "react";
import { timeAgo } from "../utils/formatTime";
import { clockTime, PROVIDER_LABEL, FILTERS, unitMatchesFilter } from "./liveLocations/constants";
import { useLiveSnapshot } from "./liveLocations/useLiveSnapshot";
import { useLeafletMap } from "./liveLocations/useLeafletMap";
import { DiagnosticsPanel } from "./liveLocations/DiagnosticsPanel";
import { MapAndUnitList } from "./liveLocations/MapAndUnitList";
import PageFailure from "../components/PageFailure";

/**
 * Live Locations — page container.
 *
 * LAYOUT AND WIRING ONLY:
 *
 *   ./liveLocations/constants.js       intervals, filter lists, pure formatters
 *   ./liveLocations/markers.js         Leaflet icons + escaped popup markup
 *   ./liveLocations/useLiveSnapshot.js the snapshot and the auto-refresh
 *   ./liveLocations/useLeafletMap.js   the map's whole lifecycle and its layers
 *   ./liveLocations/{DiagnosticsPanel,MapAndUnitList}.jsx
 *
 * The two hooks are layered rather than merged: the snapshot knows nothing
 * about the map, and the map consumes the filtered result. That order is why a
 * provider failure degrades to a banner over stale markers instead of an empty
 * page.
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
    snapshot, loading, refreshing, error, errorObject, lastUpdated, autoRefresh, setAutoRefresh,
    selectedUnit, setSelectedUnit, load, units, providerErrors,
  } = live;

  // The search first, then the filter; the counts on the filter buttons are
  // taken after the search, so each one says what its button would show.
  const searched = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return units;
    return units.filter((u) => `${u.unit || ""} ${u.driverName || ""} ${u.groupName || ""}`.toLowerCase().includes(q));
  }, [units, search]);
  const filtered = useMemo(() => searched.filter((u) => unitMatchesFilter(u, filter)), [searched, filter]);
  const filterCounts = useMemo(
    () => Object.fromEntries(FILTERS.map((f) => [f.key, searched.filter((u) => unitMatchesFilter(u, f.key)).length])),
    [searched],
  );

  const map = useLeafletMap({
    filtered, selectedUnit, setSelectedUnit,
    showDiagnostics, error, snapshot, providerErrors,
  });

  // The header toolbar renders the "Fit visible" button.
  const { fitAll } = map;


  return (
    <div>
      <div className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h2>Live Locations</h2>
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
          <button
            className={`btn btn-sm ${showDiagnostics ? "btn-primary" : "btn-ghost"}`}
            onClick={() => setShowDiagnostics((v) => !v)}
            title="Show provider/match/cache diagnostics"
          >
            🩺 Diagnostics
          </button>
        </div>
      </div>

      {/* A failed refresh keeps the last good data on screen AND names the
          cause. It used to collapse every failure into "Could not refresh live
          data", so a dispatcher could not tell a provider hiccup from an
          unreachable database or an exhausted transfer allowance. */}
      {errorObject && (
        <>
          <PageFailure
            variant="inline"
            error={errorObject}
            where="Live Locations refresh"
            onRetry={() => load({ force: true })}
          />
          {snapshot && (
            <div className="alert alert-error" style={{ marginTop: 0 }}>
              ⚠️ The map below is the last successful snapshot
              {lastUpdated ? ` (${clockTime(lastUpdated)})` : ""}, not live data.
            </div>
          )}
        </>
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

      {/* The five count cards are gone (November 2026): they repeated the
          filters below. Each filter now carries its own count, and the
          provider errors are the banner above. */}
      <MapAndUnitList
        {...map}
        filtered={filtered}
        units={units}
        selectedUnit={selectedUnit}
        search={search}
        setSearch={setSearch}
        filter={filter}
        setFilter={setFilter}
        filterCounts={filterCounts}
        loading={loading}
        snapshot={snapshot}
      />
    </div>
  );
}
