/**
 * Shared vocabulary and badges for Trailer Tracking.
 *
 * The status labels and colours live here so the list, the events table and the
 * detail drawer cannot drift into describing the same state differently.
 */

import React from "react";

const TABS = [
  { key: "list", label: "Trailer List" },
  { key: "import", label: "Upload / Import" },
  { key: "events", label: "Events History" },
  { key: "planned", label: "Planned" },
  { key: "unidentified", label: "Unidentified" },
  { key: "settings", label: "Settings" },
];

const INSTRUCTION_STATUS_LABEL = {
  pending: "Waiting for completion",
  confirmed: "Completed",
  superseded: "Superseded",
  cancelled: "Cancelled",
};
const INSTRUCTION_STATUS_COLOR = {
  pending: "#f59e0b",
  confirmed: "#22c55e",
  superseded: "#94a3b8",
  cancelled: "#94a3b8",
};

const STATUS_LABEL = {
  with_driver: "With driver",
  dropped: "Dropped",
  unknown: "Unknown",
};
const STATUS_COLOR = {
  with_driver: "#22c55e",
  dropped: "#f59e0b",
  unknown: "#94a3b8",
};
const EVENT_TYPES = ["pickup", "dropoff", "mention_only", "unidentified"];

function fmtTime(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString(); } catch { return String(iso); }
}

function StatusBadge({ status, needsReview, label }) {
  const s = status || "unknown";
  return (
    <span style={{
      display: "inline-block", padding: "2px 8px", borderRadius: 10, fontSize: 12,
      background: STATUS_COLOR[s] + "22", color: STATUS_COLOR[s], fontWeight: 600,
    }}>
      {label || STATUS_LABEL[s] || s}{needsReview ? " • review" : ""}
    </span>
  );
}

function ReviewPill() {
  return (
    <span style={{
      display: "inline-block", marginLeft: 6, padding: "1px 7px", borderRadius: 10, fontSize: 11,
      background: "#ef444422", color: "#ef4444", fontWeight: 700, border: "1px solid #ef444455",
    }}>
      Review change
    </span>
  );
}


export { TABS, INSTRUCTION_STATUS_LABEL, INSTRUCTION_STATUS_COLOR, STATUS_LABEL, STATUS_COLOR, EVENT_TYPES, fmtTime, StatusBadge, ReviewPill };
