import React from "react";
import { driverTypeLabel } from "../homeTimeViewModel";
import { fmtDate, money, requestStatusMeta } from "./labels";

/**
 * Requests and completed trips that do not point at a currently tracked driver
 * status.
 *
 * They are SHOWN rather than filtered out: a request whose driver group no
 * longer resolves is a data problem someone has to fix, and silently dropping
 * it is how a driver stops being tracked without anyone noticing.
 *
 * Its data comes from the overview (useHomeTimeOverview), not from the
 * screenshot import — it was a sibling card in the original page and stays one
 * here.
 *
 * Split out of admin/src/pages/HomeTimePage.jsx.
 */
export function UnlinkedActivityCard({ unlinkedActivity }) {
  if (!unlinkedActivity?.length) return null;

  return (
    <div className="card">
      <h3>Unlinked activity</h3>
      <p className="home-time-muted" style={{ marginTop: 0 }}>
        These requests or completed trips do not point to a currently tracked driver status, so they stay visible here instead of disappearing.
      </p>
      <div className="table-container">
        <table className="table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Driver</th>
              <th>Date</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {unlinkedActivity.map((item) => (
              <tr key={item.id}>
                <td>{item.kind === "request" ? "Request" : "Trip"}</td>
                <td>
                  <div className="home-time-driver-name">{item.driver_name}</div>
                  <div className="home-time-subtext">
                    {driverTypeLabel(item.driver_type)}
                    {item.unit_number ? ` | Unit ${item.unit_number}` : ""}
                  </div>
                </td>
                <td>{fmtDate(item.timestamp)}</td>
                <td>
                  {item.kind === "request"
                    ? `${requestStatusMeta(item.status, item.clarification_channel).label} | ${fmtDate(item.home_from)} to ${fmtDate(item.home_to)} | ${item.source || "--"}`
                    : `${fmtDate(item.road_started_at)} to ${fmtDate(item.home_arrived_at)} | ${money(item.bonus_usd)}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
