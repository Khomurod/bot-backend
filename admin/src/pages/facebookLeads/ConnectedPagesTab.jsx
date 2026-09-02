import React from "react";

/**
 * The Facebook Pages whose lead forms feed this system.
 *
 * A Page is connected from Telegram with /connect, never from here — the OAuth
 * flow needs the recruiter's own Facebook login — so this tab is read-only and
 * says as much when the list is empty.
 *
 * Split out of admin/src/pages/FacebookLeadsPage.jsx.
 */
export function ConnectedPagesTab({ pages }) {
  return (

  <div className="card" style={{ padding: 16 }}>
    <h3 style={{ marginTop: 0 }}>Connected Facebook Pages</h3>
    {pages.length === 0 ? (
      <p>No pages connected. Use /connect in a Telegram leads group.</p>
    ) : (
      <table className="data-table" style={{ width: "100%" }}>
        <thead>
          <tr>
            <th>Page</th>
            <th>Telegram group</th>
            <th>Active</th>
            <th>Connected</th>
          </tr>
        </thead>
        <tbody>
          {pages.map((p) => (
            <tr key={p.id}>
              <td>{p.page_name || p.page_id}</td>
              <td>{p.group_name || p.telegram_group_id}</td>
              <td>
                {p.is_active
                  ? <span className="status-pill status-pill--success">Yes</span>
                  : <span className="status-pill status-pill--danger">No</span>
                }
              </td>
              <td>{timeAgo(p.connected_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
  </div>
  );
}
