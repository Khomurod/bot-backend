import React from "react";
import { scopeLabel } from "./scopes";

/**
 * What is stored now: names, who reads each, and the last four characters of
 * long values — never a value. Removing one saves a new version without it.
 */
export default function StoredValuesCard({ values, busy, onRemove }) {
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3 style={{ marginTop: 0 }}>Stored values ({values.length})</h3>
      {values.length === 0 ? (
        <p style={{ marginBottom: 0 }}>Nothing is stored yet — every setting still comes from Coolify.</p>
      ) : (
        <div className="table-container">
          <table className="table">
            <thead>
              <tr><th>Name</th><th>Read by</th><th>Ends with</th><th aria-label="Actions"></th></tr>
            </thead>
            <tbody>
              {values.map((v) => (
                <tr key={`${v.scope}:${v.name}`}>
                  <td><code>{v.name}</code></td>
                  <td>{scopeLabel(v.scope)}</td>
                  <td>{v.last4 ? <code>…{v.last4}</code> : <span style={{ color: "var(--text-secondary)" }}>(short value)</span>}</td>
                  <td style={{ textAlign: "right" }}>
                    <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
                      onClick={() => onRemove(v)} aria-label={`Remove ${v.name}`}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
