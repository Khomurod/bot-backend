/**
 * Route Control label tables and pure formatters.
 *
 * The three label maps are what the admin actually reads when something goes
 * wrong — a monitor result, a blocked-tracking reason, a screenshot delivery
 * state — so they live together and hold no logic of their own.
 *
 * No I/O and no React, so the waypoint parsing and the badge/status decisions
 * are testable directly.
 *
 * Split out of admin/src/pages/RouteControlPage.jsx.
 */
export const RESULT_LABELS = {
  on_route: { text: "On route", color: "#22c55e" },
  off_route: { text: "Off route", color: "#f87171" },
  parked: { text: "Parked/slow", color: "#94a3b8" },
  stale: { text: "Stale GPS", color: "#f59e0b" },
  not_checked: { text: "Not checked", color: "#94a3b8" },
  no_geometry: { text: "No geometry", color: "#f59e0b" },
};

export function fmtMeters(m) {
  if (m == null) return "—";
  const miles = m / 1609.34;
  return miles >= 0.1 ? `${miles.toFixed(1)} mi` : `${Math.round(m)} m`;
}

export function fmtTime(iso) {
  return iso ? new Date(iso).toLocaleString() : "—";
}

/** Split waypoints entered comma- OR newline-separated into a clean array. */
export function parseWaypoints(raw) {
  return String(raw || "")
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Searchable single-select combobox: type to filter driver groups by unit
 * number, driver name, group title or driver type. Keyboard + mouse friendly.
 */

export const TRACKING_MODES = [
  { value: "after_message_sent", label: "After route message is sent (default)" },
  { value: "immediate", label: "Immediately" },
  { value: "scheduled_time", label: "At a scheduled time" },
  { value: "start_location", label: "When the truck reaches a start location" },
];

export function trackingBadge(a) {
  if (a.status !== "active") return null;
  if (a.tracking_status !== "pending") return { text: "Tracking: Active", color: "#22c55e" };
  const hold = a.tracking_hold_reason
    || (a.tracking_start_mode === "after_message_sent" ? "waiting_for_message"
      : a.tracking_start_mode === "scheduled_time" ? "waiting_for_time"
        : a.tracking_start_mode === "start_location" ? "waiting_for_location" : null);
  switch (hold) {
    case "waiting_for_message":
      return { text: "Tracking: Waiting for route message", color: "#f59e0b" };
    case "waiting_for_time":
      return { text: `Tracking: Starts ${fmtTime(a.tracking_start_at)}`, color: "#f59e0b" };
    case "waiting_for_location":
      return {
        text: `Tracking: Waiting for truck to reach start location${a.tracking_start_radius_miles ? ` (${a.tracking_start_radius_miles} mi radius)` : ""}`,
        color: "#f59e0b",
      };
    default:
      return { text: "Tracking: Pending", color: "#f59e0b" };
  }
}

/** Human explanation for a machine-readable completion_blocked_reason. */
export const BLOCKED_REASON_TEXT = {
  DESTINATION_COORDINATES_MISSING: "Cannot complete: destination coordinates are missing.",
  LIVE_GPS_MISSING: "Cannot complete: no live GPS available.",
  LIVE_GPS_STALE: "Cannot complete: GPS is stale.",
  UNIT_RESOLUTION_FAILED: "Cannot complete: the truck/unit could not be resolved.",
  OUTSIDE_COMPLETION_RADIUS: "Outside the completion radius — monitoring continues.",
  DISTANCE_UNMEASURABLE: "Cannot complete: distance to the destination could not be measured.",
};

/** Screenshot status label per the stored + delivery + in-place-edit state. */
export function screenshotStatus(a) {
  const sent = a.status !== "cancelled" && a.driver_group_message_sent_at;
  const err = a.screenshot_send_error;
  if (sent && err) {
    // Machine-readable screenshot delivery / in-place-edit outcomes.
    if (err === "SCREENSHOT_NOT_SHOWN_IN_TELEGRAM") {
      return { text: "📷 Stored — not shown in Telegram (message is text-only)", color: "#f59e0b", title: err };
    }
    if (err === "SCREENSHOT_STILL_SHOWN_IN_TELEGRAM") {
      return { text: "📷 Removed from storage — image still in the sent photo", color: "#f59e0b", title: err };
    }
    if (/TELEGRAM_EDIT|BOT_PERMISSION|MESSAGE_NOT|NO_TELEGRAM/.test(err)) {
      return { text: "📷 Telegram update failed", color: "#f59e0b", title: err };
    }
    return { text: "📷 Sent as text only (screenshot failed)", color: "#f59e0b", title: err };
  }
  if (sent && (a.driver_group_message_via === "photo" || a.driver_group_message_via === "photo+text")) {
    const edited = a.driver_group_message_edited_at ? " (updated in place)" : "";
    return { text: `📷 Sent with screenshot${edited}`, color: "#22c55e" };
  }
  if (a.has_screenshot) return { text: "📷 Screenshot stored", color: "#60a5fa" };
  return { text: "No screenshot", color: "#94a3b8" };
}
