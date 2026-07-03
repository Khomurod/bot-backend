import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import * as api from "../api";
import { timeAgo } from "../utils/formatTime";

const AUTO_REFRESH_MS = 45000;
const DEFAULT_CENTER = [39.5, -98.35]; // continental US
const DEFAULT_ZOOM = 4;

const FILTERS = [
  { key: "all", label: "All" },
  { key: "active_load", label: "Active load" },
  { key: "no_load", label: "No active load" },
  { key: "stale", label: "Stale GPS" },
  { key: "samsara", label: "Samsara" },
  { key: "factor", label: "Factor ELD" },
  { key: "leader", label: "Leader ELD" },
];

const PROVIDER_LABEL = { samsara: "Samsara", factor: "Factor ELD", leader: "Leader ELD" };

function statusColor(unit) {
  if (!unit.location) return "#94a3b8";        // no GPS — slate
  if (unit.location.isStale) return "#f59e0b";  // stale — amber
  if (unit.load) return "#22c55e";              // active load — green
  return "#3b82f6";                             // no load, fresh — blue
}

function markerIcon(unit, selected) {
  const color = statusColor(unit);
  const heading = unit.location ? unit.location.heading : null;
  const glyph = heading == null
    ? `<div style="width:12px;height:12px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 0 3px rgba(0,0,0,.6)"></div>`
    : `<div style="transform:rotate(${heading}deg);color:${color};font-size:20px;line-height:1;text-shadow:0 0 3px rgba(0,0,0,.6)">▲</div>`;
  const ring = selected ? "outline:3px solid #6366f1;outline-offset:1px;border-radius:50%;" : "";
  return L.divIcon({
    className: "ll-marker",
    html: `<div style="display:grid;place-items:center;width:28px;height:28px;${ring}">${glyph}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function fmtEta(eta) {
  if (!eta || eta.status !== "ok") return "ETA unavailable";
  const parts = [];
  if (eta.durationMinutes != null) {
    const h = Math.floor(eta.durationMinutes / 60);
    const m = eta.durationMinutes % 60;
    parts.push(h > 0 ? `${h}h ${m}m` : `${m}m`);
  }
  if (eta.distanceMiles != null) parts.push(`${eta.distanceMiles} mi`);
  return parts.length ? parts.join(" · ") : "ETA unavailable";
}

function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function popupHtml(unit) {
  const loc = unit.location;
  const load = unit.load;
  const eta = unit.eta;
  const rows = [];
  rows.push(`<div style="font-weight:700;font-size:14px;margin-bottom:2px">🚛 Unit ${escapeHtml(unit.unit)}</div>`);
  rows.push(`<div style="font-size:12px;color:#64748b;margin-bottom:6px">${escapeHtml(unit.groupName || unit.driverName || "")}</div>`);
  if (unit.provider) rows.push(`<div><b>GPS:</b> ${escapeHtml(PROVIDER_LABEL[unit.provider] || unit.provider)}</div>`);
  if (loc) {
    rows.push(`<div><b>Speed:</b> ${loc.speedMph != null ? escapeHtml(loc.speedMph) + " mph" : "—"}</div>`);
    rows.push(`<div><b>Updated:</b> ${loc.lastUpdated ? escapeHtml(timeAgo(loc.lastUpdated)) : "—"}${loc.isStale ? ' <span style="color:#f59e0b">(stale)</span>' : ""}</div>`);
  } else {
    rows.push(`<div style="color:#ef4444">No GPS available</div>`);
  }
  if (load) {
    rows.push(`<hr style="border:none;border-top:1px solid #e2e8f0;margin:6px 0"/>`);
    rows.push(`<div><b>Load:</b> ${escapeHtml(load.loadId || "—")}${load.status ? " · " + escapeHtml(load.status) : ""}</div>`);
    if (load.nextStopType) {
      rows.push(`<div><b>Next ${escapeHtml(load.nextStopType)}:</b> ${escapeHtml(load.nextStopName || load.nextStopAddress || "—")}</div>`);
      if (load.nextStopAddress) rows.push(`<div style="font-size:12px;color:#64748b">${escapeHtml(load.nextStopAddress)}</div>`);
    }
    rows.push(`<div><b>ETA:</b> ${escapeHtml(fmtEta(eta))}</div>`);
  } else {
    rows.push(`<hr style="border:none;border-top:1px solid #e2e8f0;margin:6px 0"/><div style="color:#64748b">No active load</div>`);
  }
  const btns = [];
  if (unit.telegramGroupLink) {
    btns.push(`<a href="${escapeHtml(unit.telegramGroupLink)}" target="_blank" rel="noopener" style="color:#6366f1;text-decoration:none;font-weight:600">Open driver group ↗</a>`);
  }
  btns.push(`<a href="#" data-ll-center="${escapeHtml(unit.unit)}" style="color:#6366f1;text-decoration:none;font-weight:600">Center map here</a>`);
  rows.push(`<div style="display:flex;gap:12px;margin-top:8px;font-size:12px">${btns.join("")}</div>`);
  return `<div style="min-width:210px;font-size:13px;line-height:1.5">${rows.join("")}</div>`;
}

export default function LiveLocationsPage() {
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [selectedUnit, setSelectedUnit] = useState(null);
  const [mapReady, setMapReady] = useState(false);

  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const markerLayerRef = useRef(null);
  const routeLayerRef = useRef(null);
  const markersByUnit = useRef(new Map());
  const selectedUnitRef = useRef(null);

  const units = snapshot?.units || [];
  const summary = snapshot?.summary || null;

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

  // ── Data loading ──
  const load = useCallback(async ({ initial = false, force = false } = {}) => {
    if (initial) setLoading(true); else setRefreshing(true);
    try {
      const data = await api.getLiveLocationsSnapshot({ force });
      setSnapshot(data);
      setLastUpdated(new Date());
      setError(null);
    } catch (err) {
      // Keep the previously loaded snapshot visible; just surface a banner.
      setError(err.message || "Failed to refresh");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load({ initial: true }); }, [load]);

  // Auto-refresh
  useEffect(() => {
    if (!autoRefresh) return undefined;
    const id = setInterval(() => load({ force: false }), AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, [autoRefresh, load]);

  // ── Map init ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (mapRef.current || !mapContainerRef.current) return;
      let cfg = { tileUrl: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", attribution: "&copy; OpenStreetMap contributors", maxZoom: 19 };
      try {
        const remote = await api.getLiveLocationsConfig();
        if (remote && remote.tileUrl) cfg = remote;
      } catch (_) { /* fall back to OSM defaults */ }
      if (cancelled || mapRef.current || !mapContainerRef.current) return;
      try {
        const map = L.map(mapContainerRef.current, { zoomControl: true }).setView(DEFAULT_CENTER, DEFAULT_ZOOM);
        L.tileLayer(cfg.tileUrl, { attribution: cfg.attribution, maxZoom: cfg.maxZoom || 19 }).addTo(map);
        markerLayerRef.current = L.layerGroup().addTo(map);
        routeLayerRef.current = L.layerGroup().addTo(map);
        mapRef.current = map;
        // Popup "Center map here" links.
        map.on("popupopen", (e) => {
          const node = e.popup.getElement();
          if (!node) return;
          const link = node.querySelector("[data-ll-center]");
          if (link) {
            link.addEventListener("click", (ev) => {
              ev.preventDefault();
              const u = link.getAttribute("data-ll-center");
              const m = markersByUnit.current.get(u);
              if (m) map.setView(m.getLatLng(), Math.max(map.getZoom(), 9));
            });
          }
        });
        setTimeout(() => map.invalidateSize(), 200);
        setMapReady(true);
      } catch (_) {
        setMapReady(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Keep map sized correctly on window resize.
  useEffect(() => {
    const onResize = () => { if (mapRef.current) mapRef.current.invalidateSize(); };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    return () => {
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }
    };
  }, []);

  useEffect(() => { selectedUnitRef.current = selectedUnit; }, [selectedUnit]);

  // ── Draw markers when snapshot / filter / selection changes ──
  useEffect(() => {
    const map = mapRef.current;
    const layer = markerLayerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    markersByUnit.current.clear();

    filtered.forEach((u) => {
      if (!u.location || u.location.lat == null || u.location.lng == null) return;
      const marker = L.marker([u.location.lat, u.location.lng], {
        icon: markerIcon(u, u.unit === selectedUnit),
        title: `Unit ${u.unit}`,
      });
      marker.bindPopup(popupHtml(u));
      marker.on("click", () => setSelectedUnit(u.unit));
      marker.addTo(layer);
      markersByUnit.current.set(u.unit, marker);
    });
  }, [filtered, selectedUnit]);

  // ── Route line for the selected unit ──
  useEffect(() => {
    const map = mapRef.current;
    const routeLayer = routeLayerRef.current;
    if (!map || !routeLayer) return undefined;
    routeLayer.clearLayers();
    if (!selectedUnit) return undefined;

    let cancelled = false;
    (async () => {
      try {
        const route = await api.getLiveLocationRoute(selectedUnit);
        if (cancelled || selectedUnitRef.current !== selectedUnit) return;
        if (route && route.status === "ok" && Array.isArray(route.geometry) && route.geometry.length >= 2) {
          L.polyline(route.geometry, { color: "#6366f1", weight: 4, opacity: 0.8, dashArray: "6 6" }).addTo(routeLayer);
          if (route.destination) {
            L.circleMarker([route.destination.lat, route.destination.lng], {
              radius: 7, color: "#6366f1", fillColor: "#6366f1", fillOpacity: 0.9,
            }).bindPopup("Next stop").addTo(routeLayer);
          }
        }
      } catch (_) { /* routing failure must not break the page */ }
    })();
    return () => { cancelled = true; };
  }, [selectedUnit]);

  const fitAll = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const pts = filtered
      .filter((u) => u.location && u.location.lat != null && u.location.lng != null)
      .map((u) => [u.location.lat, u.location.lng]);
    if (pts.length === 0) return;
    if (pts.length === 1) { map.setView(pts[0], 9); return; }
    map.fitBounds(L.latLngBounds(pts).pad(0.15));
  }, [filtered]);

  const selectUnit = useCallback((u) => {
    setSelectedUnit(u.unit);
    const map = mapRef.current;
    const marker = markersByUnit.current.get(u.unit);
    if (map && marker) {
      map.setView(marker.getLatLng(), Math.max(map.getZoom(), 9));
      marker.openPopup();
    }
  }, []);

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
            {refreshing ? "Refreshing…" : lastUpdated ? `Updated ${timeAgo(lastUpdated.toISOString())}` : ""}
          </span>
          <button className="btn btn-ghost btn-sm" onClick={() => load({ force: true })} disabled={refreshing}>🔄 Refresh</button>
          <button
            className={`btn btn-sm ${autoRefresh ? "btn-primary" : "btn-ghost"}`}
            onClick={() => setAutoRefresh((v) => !v)}
            title="Auto-refresh every 45s"
          >
            {autoRefresh ? "⏱ Auto: On" : "⏱ Auto: Off"}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={fitAll}>🗺 Fit all</button>
        </div>
      </div>

      {error && (
        <div className="alert alert-error" style={{ marginTop: 0 }}>
          ⚠️ {error}{snapshot ? " — showing last known data." : ""}
        </div>
      )}
      {snapshot?.stale && !error && (
        <div className="alert alert-error" style={{ marginTop: 0 }}>
          ⚠️ Live data source is temporarily unavailable — showing last known snapshot.
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

      {loading ? (
        <div className="loading"><div className="spinner"></div> Loading live locations…</div>
      ) : (
        <div style={{ display: "flex", gap: 16, alignItems: "stretch", flexWrap: "wrap" }}>
          {/* Map */}
          <div className="card" style={{ flex: "1 1 480px", minWidth: 320, padding: 0, overflow: "hidden", position: "relative" }}>
            <div ref={mapContainerRef} style={{ height: 620, width: "100%", background: "var(--bg-secondary)" }} />
            {!mapReady && (
              <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", pointerEvents: "none", color: "var(--text-muted)", fontSize: 13 }}>
                Map unavailable — unit list is still usable →
              </div>
            )}
          </div>

          {/* Side panel */}
          <div className="card" style={{ flex: "0 1 360px", minWidth: 280, display: "flex", flexDirection: "column", maxHeight: 620 }}>
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
                  <div className="icon">📭</div>
                  <p>No units match.</p>
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
                    <div style={{ fontSize: 11, color: "#f59e0b", marginTop: 2 }}>
                      ⚠ {u.warnings.map((w) => w.replace(/_/g, " ")).join(", ")}
                    </div>
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
