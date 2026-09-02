import React from "react";
import { timeAgo } from "../../utils/formatTime";
import { statusPillClass, shortenId } from "./constants";

/**
 * Recent verified webhook events, with a manual retry per row.
 *
 * A developer-only tab (?dev=1): it exposes queue internals — event ids,
 * processing status, failure reasons — that are for diagnosing a missed lead,
 * not for daily use.
 *
 * Split out of admin/src/pages/FacebookLeadsPage.jsx.
 */
export function WebhookLogTab({ webhookLog, logLoading, loadWebhookLog, handleRetry }) {
  return (

  <div className="card" style={{ padding: 16 }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <h3 style={{ marginTop: 0 }}>Activity Log</h3>
      <button type="button" className="btn btn-secondary" onClick={loadWebhookLog} disabled={logLoading}>
        Refresh
      </button>
    </div>
    {logLoading ? (
      <p>Loading...</p>
    ) : webhookLog.length === 0 ? (
      <p>No events yet.</p>
    ) : (
      <table className="data-table" style={{ width: "100%", fontSize: 13 }}>
        <thead>
          <tr>
            <th>ID</th>
            <th>Event</th>
            <th>Page</th>
            <th>Status</th>
            <th>Created</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {webhookLog.map((e) => (
            <tr key={e.id}>
              <td>{shortenId(e.id)}</td>
              <td>{e.event_type}</td>
              <td>{e.page_name || e.page_id}</td>
              <td><span className={statusPillClass(e.status)}>{e.status}</span></td>
              <td>{timeAgo(e.created_at)}</td>
              <td>
                <button type="button" className="btn btn-secondary" onClick={() => handleRetry(e.id)}>
                  Retry
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
  </div>
  );
}
