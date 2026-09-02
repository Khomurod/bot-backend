import React from "react";
import { clockTime } from "./constants";

/**
 * Provider / match / cache diagnostics, shown behind the 🩺 toggle.
 *
 * It answers "why is this truck missing?" — which providers returned vehicles,
 * how many matched a driver group, and how fresh the cache is — so the counts
 * are per provider rather than totalled.
 *
 * Split out of admin/src/pages/LiveLocationsPage.jsx.
 */
export function DiagnosticsPanel({ snapshot, lastUpdated, providerErrors }) {
  const d = snapshot?.debug || {};
  const pv = d.providerVehiclesReturned || {};
  const rows = [
    ["Snapshot generated", snapshot?.generatedAt ? clockTime(snapshot.generatedAt) : "—"],
    ["Served from cache", snapshot ? String(Boolean(snapshot.servedFromCache)) : "—"],
    ["Stale snapshot", snapshot ? String(Boolean(snapshot.isStale)) : "—"],
    ["Cache age (s)", snapshot?.cacheAgeSeconds != null ? snapshot.cacheAgeSeconds : "—"],
    ["Samsara vehicles fetched", pv.samsara == null ? "— (off)" : pv.samsara],
    ["Factor vehicles fetched", pv.factor == null ? "— (off)" : pv.factor],
    ["Leader vehicles fetched", pv.leader == null ? "— (off)" : pv.leader],
    ["App units considered", d.unitsTotal ?? "—"],
    ["Units matched to GPS", d.unitsWithGps ?? "—"],
    ["  · via Samsara", d.matchedByProvider?.samsara ?? "—"],
    ["  · via Factor", d.matchedByProvider?.factor ?? "—"],
    ["  · via Leader", d.matchedByProvider?.leader ?? "—"],
    ["Units with no GPS", d.unitsNoGps ?? "—"],
    ["Units stale GPS", d.unitsStaleGps ?? "—"],
    ["Datatruck loads fetched", d.loadsFetched ?? "—"],
    ["Datatruck loads matched", d.loadsMatched ?? "—"],
    ["  · by driver name", d.loadsMatchedByDriver ?? "—"],
    ["  · by unit number", d.loadsMatchedByUnit ?? "—"],
  ];
  return (
    <div className="card" style={{ marginBottom: 16, padding: "12px 16px" }}>
      <div style={{ fontWeight: 700, marginBottom: 8 }}>🩺 Live Locations diagnostics</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "2px 24px" }}>
        {rows.map(([label, value]) => (
          <div key={label} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "2px 0", fontFamily: "var(--font-mono, monospace)" }}>
            <span style={{ color: "var(--text-muted)", whiteSpace: "pre" }}>{label}</span>
            <span style={{ fontWeight: 600 }}>{String(value)}</span>
          </div>
        ))}
      </div>
      {providerErrors && providerErrors.length > 0 && (
        <div style={{ marginTop: 8, fontSize: 12, color: "#ef4444" }}>
          Provider errors: {providerErrors.map((e) => `${e.provider} (${e.code || "error"})`).join(", ")}
        </div>
      )}
      <div style={{ marginTop: 8, fontSize: 11, color: "var(--text-muted)" }}>
        GPS provider unavailable = Samsara/ELD problem · No active load = Datatruck/load problem · ETA unavailable = routing/next-stop problem. These are independent.
      </div>
    </div>
  );
}
