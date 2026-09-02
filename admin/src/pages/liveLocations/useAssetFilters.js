import { useState, useEffect, useMemo, useCallback } from "react";
import {
  sanitizeFilters, buildDriverPositionIndex, filterTrailers, calculateAssetCounts,
} from "../../utils/assetMapFilters";
import { ASSET_FILTERS_STORAGE_KEY, loadStoredAssetFilters } from "./storedFilters";

/**
 * The truck/trailer overlay filters, and the ONE filtered trailer dataset the
 * map and the side panel both consume.
 *
 * They share it on purpose: two independent filter passes is how a trailer ends
 * up listed in the panel but missing from the map.
 *
 * The driver index is built from ALL units even when the truck layer is hidden,
 * because a trailer with no GPS of its own derives its position from its
 * driver's truck — dropping the index in Trailers-only mode would make exactly
 * those trailers vanish.
 *
 * Split out of admin/src/pages/LiveLocationsPage.jsx.
 */
export function useAssetFilters({ units, trailers, search }) {
  const [assetFilters, setAssetFilters] = useState(loadStoredAssetFilters);
  const showTrucks = assetFilters.assetView !== "trailers";
  const showTrailers = assetFilters.assetView !== "trucks";

  // deliberately not persisted).
  useEffect(() => {
    try { localStorage.setItem(ASSET_FILTERS_STORAGE_KEY, JSON.stringify(assetFilters)); } catch (_) { /* blocked */ }
  }, [assetFilters]);
  const setAssetFilter = useCallback((patch) => setAssetFilters((f) => sanitizeFilters({ ...f, ...patch })), []);

  // ── Shared filtered trailer dataset (map + side panel consume EXACTLY this).
  //    The driver index is built once per snapshot from ALL units — even when
  //    the truck layer is hidden — so with-driver trailers keep their derived
  //    coordinates in Trailers-only mode. ──
  const driverIndex = useMemo(
    () => buildDriverPositionIndex(units.map((u) => ({
      names: [u.driverName, u.groupName],
      lat: u.location ? u.location.lat : null,
      lng: u.location ? u.location.lng : null,
      unit: u.unit,
    }))),
    [units]
  );
  const visibleTrailers = useMemo(
    () => filterTrailers(trailers, assetFilters, { driverIndex, search }),
    [trailers, assetFilters, driverIndex, search]
  );
  const mappableTrailers = useMemo(
    () => visibleTrailers.filter((e) => e.position.lat != null && e.position.lng != null),
    [visibleTrailers]
  );
  const trailerTextOnly = useMemo(
    () => visibleTrailers.filter((e) => e.position.lat == null || e.position.lng == null),
    [visibleTrailers]
  );
  const trailerCounts = useMemo(
    () => calculateAssetCounts({ trucks: [], trailers, driverIndex }),
    [trailers, driverIndex]
  );

  return {
    assetFilters, setAssetFilter, showTrucks, showTrailers,
    driverIndex, visibleTrailers, mappableTrailers, trailerTextOnly, trailerCounts,
  };
}
