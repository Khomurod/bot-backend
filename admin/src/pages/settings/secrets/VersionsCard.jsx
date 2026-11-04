import React from "react";

function when(value) {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
}

/**
 * Every save is a version. Restoring one saves it again as the newest — the
 * history is never rewritten. If a saved version keeps the app from starting,
 * this page is not reachable: set APP_SECRETS_VERSION=<number> in Coolify instead.
 */
export default function VersionsCard({ versions, latestId, inUseId = null, busy, onRestore }) {
  if (!versions.length) return null;
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Versions</h3>
      <p style={{ color: "var(--text-secondary)", marginTop: 0 }}>
        If a saved version ever stops the app from starting, this page will not open: in Coolify set
        <code> APP_SECRETS_VERSION</code> to an earlier number below and redeploy, or <code>APP_SECRETS_OFF=true</code> to
        use only Coolify's values.
      </p>
      <div className="table-container">
        <table className="table">
          <thead>
            <tr><th>#</th><th>Saved</th><th>By</th><th>What</th><th>Values</th><th aria-label="Actions"></th></tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.id}>
                <td>
                  {v.id}
                  {v.id === inUseId ? " (in use)" : ""}
                  {v.id === latestId && v.id !== inUseId ? " (newest)" : ""}
                </td>
                <td>{when(v.createdAt)}</td>
                <td>{v.createdBy || "—"}</td>
                <td>{v.note || "—"}</td>
                <td>{v.valueCount}</td>
                <td style={{ textAlign: "right" }}>
                  {v.id !== latestId && (
                    <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !v.sameKey}
                      title={v.sameKey ? undefined : "Stored under a different INTEGRATION_SECRET_KEY"}
                      onClick={() => onRestore(v)}>Restore</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
