import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import * as api from "../api";
import { timeAgo } from "../utils/formatTime";
import { markerColor, displayTrailerStatus } from "../utils/trailerState";

const AUTO_REFRESH_MS = 45000;
const DEFAULT_CENTER = [39.5, -98.35]; // continental US
const DEFAULT_ZOOM = 4;

// Module-level cache of the last successful snapshot. It lives outside the
// component so navigating away from Live Locations and back does NOT cold-start
// the page: on remount we render this immediately and refresh quietly in the
// background. Kept tiny (one snapshot, not GPS history) and never persisted to
// disk, so it holds no secrets beyond the current page's own data.
let lastGoodSnapshot = null;
let lastGoodAt = null;

function clockTime(date) {
  try {
    return new Date(date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch (_) {
    return "";
  }
}

const FILTERS = [
  { key: "all", label: "All" },
  { key: "active_load", label: "Active load" },
  { key: "no_load", label: "No active load" },
  { key: "stale", label: "Stale GPS" },
  { key: "samsara", label: "Samsara" },
  { key: "factor", label: "Factor ELD" },
  { key: "leader", label: "Leader ELD" },
];

const PROVIDER_LABEL = {
  samsara: "Samsara", factor: "Factor ELD", leader: "Leader ELD",
  datatruck: "Datatruck (loads)", snapshot: "Snapshot",
};

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

// ── Trailer overlay (rectangles) ─────────────────────────────────────────────
const TRAILER_STATUS_LABEL = { with_driver: "With driver", dropped: "Dropped", unknown: "Unknown" };

/** Normalize a driver name for matching a trailer to a live truck/group. */
function normName(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Decide how to render a trailer: effective coordinates (derived from the
 * matched driver/truck when the trailer is with a driver), a color by
 * status/precision, and whether it needs a review outline. Returns null when the
 * trailer has no mappable location (caller lists it text-only instead).
 */
function resolveTrailer(t, unitByName) {
  const needsReview = !!t.status_needs_review;
  let lat = t.current_lat;
  let lng = t.current_lng;
  let source = t.location_source || (lat != null ? "exact" : null);
  let derived = false;
  let derivedFrom = null;

  if (t.current_status === "with_driver") {
    const u = unitByName.get(normName(t.current_driver_name));
    if (u && u.location && u.location.lat != null && u.location.lng != null) {
      lat = u.location.lat;
      lng = u.location.lng;
      source = "derived_from_driver";
      derived = true;
      derivedFrom = u.unit;
    }
  }
  if (lat == null || lng == null) return null;

  const approximate = source === "approximate_state" || source === "approximate";
  // Color reflects possession + cargo (one trailer truth) via the shared helper:
  // Dropped/Empty=orange, Dropped/Loaded=purple, With driver/Empty=green,
  // With driver/Loaded=violet, With driver/Unknown=blue.
  const color = markerColor(t);

  return { lat, lng, color, approximate, derived, derivedFrom, needsReview, source };
}

function trailerIcon(r) {
  const border = r.needsReview ? "3px solid #ef4444" : "2px solid #fff";
  const dashed = r.approximate ? "border-style:dashed;" : "";
  // Derived trailers are nudged to the RIGHT of the truck triangle via anchor.
  return L.divIcon({
    className: "trailer-ll-marker",
    html: `<div style="width:15px;height:11px;border-radius:2px;background:${r.color};${dashed}border:${border};box-shadow:0 0 3px rgba(0,0,0,.6)"></div>`,
    iconSize: [15, 11],
    iconAnchor: r.derived ? [-8, 5] : [7, 5],
  });
}

function trailerPopupHtml(t, r) {
  const rows = [];
  rows.push(`<div style="font-weight:700;font-size:14px;margin-bottom:2px">🚚 Trailer ${escapeHtml(t.unit_number)}</div>`);
  rows.push(`<div><b>Status:</b> ${escapeHtml(displayTrailerStatus(t))}${r.needsReview ? ' <span style="color:#ef4444">• review</span>' : ""}</div>`);
  rows.push(`<div><b>Driver:</b> ${escapeHtml(t.current_driver_name || "—")}</div>`);
  rows.push(`<div><b>Location:</b> ${escapeHtml(t.current_location_text || "—")}</div>`);
  if (r.derived) rows.push(`<div style="color:#22c55e;font-size:12px">Location derived from driver/truck live location${r.derivedFrom ? " (unit " + escapeHtml(r.derivedFrom) + ")" : ""}.</div>`);
  else if (r.approximate) rows.push(`<div style="color:#8b5cf6;font-size:12px">Approximate location (${escapeHtml(r.source)}).</div>`);
  rows.push(`<div><b>Condition:</b> ${escapeHtml(t.current_condition || "—")}</div>`);
  rows.push(`<div><b>Reporter:</b> ${escapeHtml(t.last_reporter_name || "—")}</div>`);
  rows.push(`<div><b>Last event:</b> ${escapeHtml(t.last_event_at ? new Date(t.last_event_at).toLocaleString() : "—")}</div>`);
  rows.push(`<div style="margin-top:8px;font-size:12px"><a href="#/trailers" style="color:#6366f1;text-decoration:none;font-weight:600">Open Trailer Tracking ↗</a></div>`);
  return `<div style="min-width:210px;font-size:13px;line-height:1.5">${rows.join("")}</div>`;
}

/**
 * Admin-only diagnostics: exactly the secret-free counts the backend already
 * computes on every snapshot build (services/liveLocationsService.js `debug`),
 * plus cache freshness. Lets the owner see WHY the map looks the way it does —
 * how many vehicles each provider returned, how many units matched, how many
 * loads matched (and by driver vs unit), provider errors, and whether the data
 * on screen is fresh or a cached/stale snapshot.
 */
function DiagnosticsPanel({ snapshot, lastUpdated, providerErrors }) {
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

export default function LiveLocationsPage() {
  // Seed from the module cache so a remount shows the last good data instantly
  // (no cold "Loading…" state) and just refreshes in the background.
  const [snapshot, setSnapshot] = useState(lastGoodSnapshot);
  const [loading, setLoading] = useState(!lastGoodSnapshot);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(lastGoodAt);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [selectedUnit, setSelectedUnit] = useState(null);
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState(null);
  const [tileError, setTileError] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [showTrailers, setShowTrailers] = useState(true);
  const [trailers, setTrailers] = useState([]);

  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const markerLayerRef = useRef(null);
  const routeLayerRef = useRef(null);
  const trailerLayerRef = useRef(null);
  const markersByUnit = useRef(new Map());
  const selectedUnitRef = useRef(null);

  const units = snapshot?.units || [];
  const summary = snapshot?.summary || null;
  const providerErrors = snapshot?.errors || [];

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
  // `initial` only means "cold start" when there is NO cached snapshot to show.
  // When we already have data (module cache or a prior refresh) every fetch is a
  // quiet background refresh that never blanks the map/list.
  const load = useCallback(async ({ initial = false, force = false } = {}) => {
    const haveData = Boolean(lastGoodSnapshot);
    if (initial && !haveData) setLoading(true); else setRefreshing(true);
    try {
      const data = await api.getLiveLocationsSnapshot({ force });
      const at = new Date();
      lastGoodSnapshot = data;
      lastGoodAt = at;
      setSnapshot(data);
      setLastUpdated(at);
      setError(null);
      // Trailers are an OPTIONAL overlay: a failure here must never surface an
      // error or blank the trucks — keep the last-known trailer list.
      try {
        const td = await api.getTrailerMapData();
        setTrailers(td.trailers || []);
      } catch (_) { /* keep previous trailers */ }
    } catch (err) {
      // Keep the previously loaded snapshot visible; just surface a banner.
      setError(err.message || "Failed to refresh");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load({ initial: true }); }, [load]);

  // If the selected unit vanishes from a fresh snapshot, drop the selection so
  // we don't hold a stale route/highlight; otherwise keep it across refreshes.
  useEffect(() => {
    if (!selectedUnit || !snapshot) return;
    if (!(snapshot.units || []).some((u) => u.unit === selectedUnit)) {
      setSelectedUnit(null);
    }
  }, [snapshot, selectedUnit]);

  // Auto-refresh
  useEffect(() => {
    if (!autoRefresh) return undefined;
    const id = setInterval(() => load({ force: false }), AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, [autoRefresh, load]);

  // ── Map init ──
  // The map must initialize independently of GPS/load/route data — it only needs
  // the container in the DOM. The container is always rendered (see JSX), so this
  // runs once on mount. Any real Leaflet failure is captured in `mapError` with a
  // human-readable reason; tile-fetch failures are non-fatal (`tileError`).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (mapRef.current || !mapContainerRef.current) return;
      // Default to OpenStreetMap; the backend /config may override with a
      // production tile provider (MAP_TILE_URL / MAP_TILE_ATTRIBUTION).
      let cfg = {
        tileUrl: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19,
      };
      try {
        const remote = await api.getLiveLocationsConfig();
        if (remote && remote.tileUrl) cfg = remote;
      } catch (_) { /* fall back to OSM defaults */ }
      if (cancelled || mapRef.current || !mapContainerRef.current) return;
      try {
        const map = L.map(mapContainerRef.current, { zoomControl: true }).setView(DEFAULT_CENTER, DEFAULT_ZOOM);
        const tiles = L.tileLayer(cfg.tileUrl, { attribution: cfg.attribution, maxZoom: cfg.maxZoom || 19 });
        // A tile that fails to load is a provider/network problem, NOT a map
        // failure — keep the map (and unit list) usable and just warn.
        tiles.on("tileerror", () => { if (!cancelled) setTileError(true); });
        tiles.on("load", () => { if (!cancelled) setTileError(false); });
        tiles.addTo(map);
        markerLayerRef.current = L.layerGroup().addTo(map);
        routeLayerRef.current = L.layerGroup().addTo(map);
        trailerLayerRef.current = L.layerGroup().addTo(map);
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
        // Container starts at 620px tall, but invalidate once painted so Leaflet
        // picks up the real size (fixes grey tiles when mounted while hidden).
        setTimeout(() => { if (mapRef.current) mapRef.current.invalidateSize(); }, 200);
        setMapReady(true);
        setMapError(null);
      } catch (err) {
        // Genuine Leaflet initialization failure — surface the real reason.
        setMapReady(false);
        setMapError(err && err.message ? err.message : "Map library failed to initialize.");
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

  // Re-measure after any layout-affecting change (map becomes ready, diagnostics
  // panel toggles, banners appear/disappear) so Leaflet never renders shrunk.
  useEffect(() => {
    if (!mapReady || !mapRef.current) return undefined;
    const id = setTimeout(() => { if (mapRef.current) mapRef.current.invalidateSize(); }, 150);
    return () => clearTimeout(id);
  }, [mapReady, showDiagnostics, error, snapshot?.isStale, providerErrors.length]);

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
  }, [filtered, selectedUnit, mapReady]);

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
  }, [selectedUnit, mapReady]);

  // ── Draw trailer rectangles (overlay). Independent of truck markers so it
  //    can be toggled without touching them. Derives a with-driver trailer's
  //    position from its matched live truck. ──
  useEffect(() => {
    const map = mapRef.current;
    const layer = trailerLayerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    if (!showTrailers) return;

    const unitByName = new Map();
    units.forEach((u) => {
      if (u.driverName) unitByName.set(normName(u.driverName), u);
      if (u.groupName) unitByName.set(normName(u.groupName), u);
    });

    trailers.forEach((t) => {
      const r = resolveTrailer(t, unitByName);
      if (!r) return; // text-only / unknown — shown in the side list instead
      const marker = L.marker([r.lat, r.lng], { icon: trailerIcon(r), title: `Trailer ${t.unit_number}` });
      marker.bindPopup(trailerPopupHtml(t, r));
      marker.addTo(layer);
    });
  }, [trailers, showTrailers, units, mapReady]);

  const trailerTextOnly = useMemo(() => {
    if (!showTrailers) return [];
    const unitByName = new Map();
    units.forEach((u) => {
      if (u.driverName) unitByName.set(normName(u.driverName), u);
      if (u.groupName) unitByName.set(normName(u.groupName), u);
    });
    return trailers.filter((t) => !resolveTrailer(t, unitByName));
  }, [trailers, showTrailers, units]);

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
          <button className="btn btn-ghost btn-sm" onClick={fitAll}>🗺 Fit all</button>
          <button
            className={`btn btn-sm ${showTrailers ? "btn-primary" : "btn-ghost"}`}
            onClick={() => setShowTrailers((v) => !v)}
            title="Show / hide trailer markers (does not affect trucks)"
          >
            🚚 Trailers: {showTrailers ? "On" : "Off"}
          </button>
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

      {/* Trailer overlay legend + text-only trailers (not mappable). */}
      {showTrailers && trailers.length > 0 && (
        <div className="card" style={{ padding: 12, marginTop: 16 }}>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center", fontSize: 12 }}>
            <strong>Trailers ({trailers.length})</strong>
            {[
              { c: "#22c55e", l: "With driver (derived)" },
              { c: "#f59e0b", l: "Dropped (exact)" },
              { c: "#8b5cf6", l: "Approximate", dashed: true },
              { c: "#3b82f6", l: "Geocoded" },
            ].map((s) => (
              <span key={s.l} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                <span style={{ width: 15, height: 11, borderRadius: 2, background: s.c, border: "2px solid #fff", borderStyle: s.dashed ? "dashed" : "solid", display: "inline-block" }} />
                {s.l}
              </span>
            ))}
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 15, height: 11, borderRadius: 2, border: "2px solid #ef4444", display: "inline-block" }} /> Needs review
            </span>
          </div>
          {trailerTextOnly.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>
                Text-only / unknown location ({trailerTextOnly.length}) — not mappable:
              </div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                {trailerTextOnly.map((t) => (
                  <li key={t.trailer_id}>
                    <strong>{t.unit_number}</strong> — {t.current_location_text || "(unknown)"} ({TRAILER_STATUS_LABEL[t.current_status] || t.current_status})
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
