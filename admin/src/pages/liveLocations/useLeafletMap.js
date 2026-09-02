import { useState, useEffect, useRef, useCallback } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import * as api from "../../api";
import { displayTrailerStatus } from "../../utils/trailerState";
import { getVisibleMapPoints, trailerAriaLabel } from "../../utils/assetMapFilters";
import { DEFAULT_CENTER, DEFAULT_ZOOM } from "./constants";
import { markerIcon, popupHtml, trailerIcon, trailerPopupHtml } from "./markers";

/**
 * The Leaflet map's whole lifecycle: creation, sizing, the three layers
 * (trucks, route, trailers), and the fit/select actions.
 *
 * FOUR THINGS HERE ARE LOAD-BEARING:
 *
 *  1. The map initializes from the CONTAINER ALONE, never from data. The
 *     container is always rendered, so a snapshot that fails to load still
 *     leaves a usable map instead of an empty page.
 *  2. A failed TILE fetch is not a map failure. `tileError` warns; `mapError`
 *     is reserved for a genuine Leaflet initialization error, so a flaky tile
 *     CDN cannot make the page look broken.
 *  3. Trucks, route and trailers are three SEPARATE layer groups, each redrawn
 *     by its own effect. Toggling the trailer overlay therefore never
 *     re-renders the truck markers or drops the selected unit's route.
 *  4. invalidateSize() is re-run after anything that changes layout — map
 *     ready, diagnostics toggled, a banner appearing — because Leaflet
 *     measures once and otherwise renders grey shrunken tiles.
 *
 * A route fetch races against selection changes, so it compares against
 * selectedUnitRef before drawing: without that, clicking through three units
 * quickly can leave the first one's route on the map.
 *
 * Split out of admin/src/pages/LiveLocationsPage.jsx.
 */
export function useLeafletMap({
  filtered, selectedUnit, setSelectedUnit, showTrucks, showTrailers,
  mappableTrailers, showDiagnostics, error, snapshot, providerErrors,
}) {
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState(null);
  const [tileError, setTileError] = useState(false);

  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const markerLayerRef = useRef(null);
  const routeLayerRef = useRef(null);
  const trailerLayerRef = useRef(null);
  const markersByUnit = useRef(new Map());
  const selectedUnitRef = useRef(null);

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
    // Trailers-only mode: hide the truck layer but keep the units data loaded —
    // it still powers trailer coordinate derivation and the diagnostics.
    if (!showTrucks) return;

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
  }, [filtered, selectedUnit, mapReady, showTrucks]);

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


  // ── Draw trailer rectangles (overlay). Independent of truck markers so
  //    toggling/filtering never touches them. ──
  useEffect(() => {
    const map = mapRef.current;
    const layer = trailerLayerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    if (!showTrailers) return;
    const seenAt = new Map(); // co-located rectangles get a small pixel offset
    mappableTrailers.forEach((entry) => {
      const key = `${entry.position.lat.toFixed(5)},${entry.position.lng.toFixed(5)}`;
      const dupIndex = seenAt.get(key) || 0;
      seenAt.set(key, dupIndex + 1);
      const marker = L.marker([entry.position.lat, entry.position.lng], {
        icon: trailerIcon(entry, dupIndex),
        title: `Trailer ${entry.trailer.unit_number} — ${displayTrailerStatus(entry.trailer)}`,
        alt: trailerAriaLabel(entry.trailer, entry.quality),
      });
      marker.bindPopup(trailerPopupHtml(entry));
      marker.addTo(layer);
    });
  }, [mappableTrailers, showTrailers, mapReady]);

  // Fit to the CURRENTLY VISIBLE filtered markers only (hidden trucks and
  // filtered-out trailers never affect the bounds). Never throws on empty.
  const fitAll = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const truckPts = showTrucks
      ? filtered
        .filter((u) => u.location && u.location.lat != null && u.location.lng != null)
        .map((u) => [u.location.lat, u.location.lng])
      : [];
    const pts = truckPts.concat(getVisibleMapPoints([], showTrailers ? mappableTrailers : []));
    if (pts.length === 0) return;
    if (pts.length === 1) { map.setView(pts[0], 9); return; }
    map.fitBounds(L.latLngBounds(pts).pad(0.15));
  }, [filtered, showTrucks, showTrailers, mappableTrailers]);

  const selectUnit = useCallback((u) => {
    setSelectedUnit(u.unit);
    const map = mapRef.current;
    const marker = markersByUnit.current.get(u.unit);
    if (map && marker) {
      map.setView(marker.getLatLng(), Math.max(map.getZoom(), 9));
      marker.openPopup();
    }
  }, []);

  return {
    mapReady, mapError, tileError,
    mapContainerRef, markersByUnit,
    fitAll, selectUnit,
  };
}
