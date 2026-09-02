import L from "leaflet";
import { timeAgo } from "../../utils/formatTime";
import { trailerMarkerStyle, displayTrailerStatus } from "../../utils/trailerState";
import { cargoGlyph } from "../../utils/assetMapFilters";
import { statusColor, escapeHtml, fmtEta } from "./constants";

/**
 * Leaflet marker icons and popup markup for trucks and trailers.
 *
 * Leaflet popups take an HTML STRING, not React, so every interpolated value
 * goes through escapeHtml() — unit numbers, driver names, trailer numbers and
 * load references are all operator-entered text that reaches this markup
 * verbatim.
 *
 * The glyph inside each marker (a heading arrow for trucks, E/L/?/! for
 * trailers) carries the state without relying on color, which matters on a map
 * where markers overlap and on a monochrome print.
 *
 * Split out of admin/src/pages/LiveLocationsPage.jsx.
 */
export function markerIcon(unit, selected) {
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

export function popupHtml(unit) {
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
// Position derivation, filtering, counts, and location quality all come from
// the shared pure helper (utils/assetMapFilters) over the UNIFIED trailer
// state payload (/trailers/states — TrailerStateService). The frontend never
// reclassifies possession/cargo/review; it only hides/shows what the backend
// decided.

export function trailerIcon(entry, offsetIndex = 0) {
  const style = trailerMarkerStyle(entry.trailer);
  const glyph = cargoGlyph(entry.trailer);
  const border = style.outline === "#ef4444" ? "2px solid #ef4444" : `2px solid ${style.dashed ? style.color : "#fff"}`;
  const dashed = style.dashed ? "border-style:dashed;" : "";
  const baseX = entry.position.derived ? -8 : 10;
  return L.divIcon({
    className: "trailer-ll-marker",
    html: `<div role="img" aria-label="${escapeHtml(trailerAriaLabel(entry.trailer, entry.quality))}"
      style="width:20px;height:14px;border-radius:2px;background:${style.color};${dashed}border:${border};
      box-shadow:0 0 3px rgba(0,0,0,.6);display:grid;place-items:center;
      font:700 10px/1 system-ui,sans-serif;color:#fff;text-shadow:0 0 2px rgba(0,0,0,.8)">${glyph}</div>`,
    iconSize: [20, 14],
    iconAnchor: [baseX - offsetIndex * 12, 7],
  });
}

export function trailerPopupHtml(entry) {
  const t = entry.trailer;
  const needsReview = Boolean(t.needs_review || t.status_needs_review);
  const rows = [];
  rows.push(`<div style="font-weight:700;font-size:14px;margin-bottom:2px">🚚 Trailer ${escapeHtml(t.unit_number)}</div>`);
  rows.push(`<div><b>Status:</b> ${escapeHtml(displayTrailerStatus(t))}${needsReview ? ' <span style="color:#ef4444">• review</span>' : ""}</div>`);
  rows.push(`<div><b>Driver:</b> ${escapeHtml(t.current_driver_name || "—")}</div>`);
  rows.push(`<div><b>Location:</b> ${escapeHtml(t.location_text || "—")}</div>`);
  if (entry.position.derived) rows.push(`<div style="color:#22c55e;font-size:12px">Location derived from driver/truck live location${entry.position.derivedFromUnit ? " (unit " + escapeHtml(entry.position.derivedFromUnit) + ")" : ""}.</div>`);
  else if (entry.quality === "approximate") rows.push(`<div style="color:#8b5cf6;font-size:12px">Approximate location (${escapeHtml(t.location_source || "approximate")}).</div>`);
  rows.push(`<div><b>Condition:</b> ${escapeHtml(t.condition_text || "—")}</div>`);
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
