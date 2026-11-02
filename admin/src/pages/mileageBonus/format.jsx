import React from "react";

/**
 * Mileage Bonuses: the status badge and the number formats both of its tables
 * use. Split out of MileageBonusPage.jsx (November 2026).
 */
export const STATUS_BADGE = {
  pending: { label: "Pending", bg: "var(--warning-soft)", color: "var(--warning)" },
  paid: { label: "Paid", bg: "var(--success-soft)", color: "var(--success)" },
  rejected: { label: "Rejected", bg: "var(--danger-soft)", color: "var(--danger)" },
  disregarded: { label: "Disregarded", bg: "var(--neutral-soft)", color: "var(--text-muted)" },
};

export function fmtMiles(value) {
  return Math.round(Number(value) || 0).toLocaleString("en-US");
}

export function fmtAmount(value) {
  return `$${(Math.round(Number(value) || 0)).toLocaleString("en-US")}`;
}

export function fmtDate(value) {
  if (!value) return "—";
  return String(value).slice(0, 10);
}

export function StatusBadge({ status }) {
  const cfg = STATUS_BADGE[status] || { label: status || "—", bg: "var(--neutral-soft)", color: "var(--text-muted)" };
  return (
    <span style={{
      display: "inline-block",
      padding: "2px 10px",
      borderRadius: 999,
      fontSize: 12,
      fontWeight: 600,
      background: cfg.bg,
      color: cfg.color,
    }}>
      {cfg.label}
    </span>
  );
}
