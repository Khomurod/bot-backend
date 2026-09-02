import { useState, useEffect, useCallback } from "react";
import * as api from "../../api";
import useVisibleInterval from "../../utils/useVisibleInterval";
import { AUTO_REFRESH_MS } from "./constants";

const DEFAULT_ZOOM = 4;

// Module-level cache of the last successful snapshot. It lives outside the
// component so navigating away from Live Locations and back does NOT cold-start
// the page: on remount we render this immediately and refresh quietly in the
// background. Kept tiny (one snapshot, not GPS history) and never persisted to
// disk, so it holds no secrets beyond the current page's own data.
let lastGoodSnapshot = null;
let lastGoodAt = null;

/**
 * The live snapshot: truck positions, loads and ETAs, plus the optional
 * trailer-state overlay.
 *
 * A FAILED REFRESH NEVER BLANKS THE MAP. The previous snapshot stays on screen
 * behind a banner, because a dispatcher acting on five-minute-old positions is
 * far better served than one staring at an error page. The trailer fetch is
 * nested in its own try/catch for the same reason: trailers are an overlay, so
 * their failure must not take the trucks down with them.
 *
 * The module-level cache above survives navigation, so returning to the page
 * renders the last good data immediately and refreshes quietly behind it.
 *
 * Polling is gated on tab visibility, so a dashboard left open in a background
 * tab stops calling the providers entirely.
 *
 * Split out of admin/src/pages/LiveLocationsPage.jsx.
 */
export function useLiveSnapshot() {
  // Seed from the module cache so a remount shows the last good data instantly
  // (no cold "Loading…" state) and just refreshes in the background.
  const [snapshot, setSnapshot] = useState(lastGoodSnapshot);
  const [loading, setLoading] = useState(!lastGoodSnapshot);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(lastGoodAt);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [trailers, setTrailers] = useState([]);
  const [selectedUnit, setSelectedUnit] = useState(null);

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
      // error or blank the trucks — keep the last-known trailer list. Uses the
      // UNIFIED trailer-state endpoint (TrailerStateService), not the legacy
      // raw-row /trailers/map payload.
      try {
        const td = await api.getTrailerStates();
        setTrailers(td.states || []);
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

  useEffect(() => { load({ initial: true }); }, [load]);

  // If the selected unit vanishes from a fresh snapshot, drop the selection so
  // we don't hold a stale route/highlight; otherwise keep it across refreshes.
  useEffect(() => {
    if (!selectedUnit || !snapshot) return;
    if (!(snapshot.units || []).some((u) => u.unit === selectedUnit)) {
      setSelectedUnit(null);
    }
  }, [snapshot, selectedUnit]);

  // Auto-refresh — paused while the browser tab is hidden (refreshes on return)
  // so a live-map dashboard left open does not poll the database indefinitely.
  useVisibleInterval(() => load({ force: false }), AUTO_REFRESH_MS, autoRefresh);

  return {
    snapshot, loading, refreshing, error, lastUpdated,
    autoRefresh, setAutoRefresh, trailers,
    selectedUnit, setSelectedUnit, load,
    units: snapshot?.units || [],
    summary: snapshot?.summary || null,
    providerErrors: snapshot?.errors || [],
  };
}
