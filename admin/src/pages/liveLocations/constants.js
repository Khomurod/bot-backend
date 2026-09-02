/**
 * Live Locations constants and the small pure formatters the panel renders
 * with.
 *
 * AUTO_REFRESH_MS is 45s deliberately: the snapshot fans out to every location
 * provider, so a shorter interval multiplies upstream API calls without giving
 * a dispatcher newer data than the providers themselves publish. The interval
 * is also gated on tab visibility (see ../../utils/useVisibleInterval), so a
 * background tab stops polling entirely.
 *
 * Split out of admin/src/pages/LiveLocationsPage.jsx.
 */
export const AUTO_REFRESH_MS = 45000;
export const DEFAULT_CENTER = [39.5, -98.35]; // continental US
export const DEFAULT_ZOOM = 4;

// Module-level cache of the last successful snapshot. It lives outside the
// component so navigating away from Live Locations and back does NOT cold-start
// the page: on remount we render this immediately and refresh quietly in the
// background. Kept tiny (one snapshot, not GPS history) and never persisted to
// disk, so it holds no secrets beyond the current page's own data.
let lastGoodSnapshot = null;
let lastGoodAt = null;

export function clockTime(date) {
  try {
    return new Date(date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch (_) {
    return "";
  }
}

export const FILTERS = [
  { key: "all", label: "All" },
  { key: "active_load", label: "Active load" },
  { key: "no_load", label: "No active load" },
  { key: "stale", label: "Stale GPS" },
  { key: "samsara", label: "Samsara" },
  { key: "factor", label: "Factor ELD" },
  { key: "leader", label: "Leader ELD" },
];

export const PROVIDER_LABEL = {
  samsara: "Samsara", factor: "Factor ELD", leader: "Leader ELD",
  datatruck: "Datatruck (loads)", snapshot: "Snapshot",
};

export function statusColor(unit) {
  if (!unit.location) return "#94a3b8";        // no GPS — slate
  if (unit.location.isStale) return "#f59e0b";  // stale — amber
  if (unit.load) return "#22c55e";              // active load — green
  return "#3b82f6";                             // no load, fresh — blue
}

export function fmtEta(eta) {
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

export function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * Trailer rectangle icon. The in-marker glyph (E/L/?/!) keeps the state
 * readable without color; `offsetIndex` nudges co-located rectangles apart.
 */
