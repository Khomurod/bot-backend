import React from "react";
import { fmtAmount, fmtMiles, StatusBadge } from "./format";

/**
 * Mileage Bonuses: a table of bonus notifications, used twice — the ones still
 * waiting for a decision, and the decided history (collapsed). Split out of
 * MileageBonusPage.jsx (November 2026). Resend and Disregard ask first, in the
 * page's handlers.
 */
export default function BonusNotificationsTable({ rows, rowBusy, onResend, onDisregard }) {
  return (
    <div className="card" style={{ overflowX: "auto" }}>
      <table className="data-table" style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left" }}>Driver</th>
            <th style={{ textAlign: "right" }}>Milestone</th>
            <th style={{ textAlign: "right" }}>Bonus</th>
            <th style={{ textAlign: "right" }}>Miles at notify</th>
            <th style={{ textAlign: "left" }}>Status</th>
            <th style={{ textAlign: "left" }}>Decided by</th>
            <th style={{ textAlign: "left" }}>Sent</th>
            <th style={{ textAlign: "left" }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((n) => (
            <tr key={n.id}>
              <td style={{ fontWeight: 600 }}>{n.driver_name}</td>
              <td style={{ textAlign: "right" }}>{fmtMiles(n.threshold_miles)} mi</td>
              <td style={{ textAlign: "right" }}>{fmtAmount(n.bonus_amount)}</td>
              <td style={{ textAlign: "right" }}>{fmtMiles(n.miles_at_notification)}</td>
              <td><StatusBadge status={n.status} /></td>
              <td>{n.decided_by_username ? `@${n.decided_by_username}` : "—"}</td>
              <td style={{ fontSize: 12, color: "var(--text-muted)" }}>
                {n.created_at ? new Date(n.created_at).toLocaleString() : "—"}
              </td>
              <td>
                {n.status !== "paid" && (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button
                      className="btn btn-ghost"
                      style={{ padding: "4px 8px", fontSize: 12 }}
                      disabled={Boolean(rowBusy[`notification:${n.id}`])}
                      onClick={() => onResend(n)}
                    >
                      Resend
                    </button>
                    {n.status !== "disregarded" && (
                      <button
                        className="btn btn-ghost"
                        style={{ padding: "4px 8px", fontSize: 12, color: "var(--danger)" }}
                        disabled={Boolean(rowBusy[`notification:${n.id}`])}
                        onClick={() => onDisregard(n)}
                      >
                        Disregard
                      </button>
                    )}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
