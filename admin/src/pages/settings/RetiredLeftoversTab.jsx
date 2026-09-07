import React, { useCallback, useEffect, useState } from "react";
import * as api from "../../api";
import PageFailure from "../../components/PageFailure";

/**
 * Settings → Retired feature leftovers.
 *
 * Removing a feature from the code does not remove its tables or its permission
 * rows — on purpose, so that a deploy can never destroy history. This tab is
 * the deliberate second step, and it is built to be read before it is used:
 * every group shows how many tables it still has and how many rows are in them,
 * so nothing is deleted sight-unseen.
 *
 * TWO ACTIONS, DELIBERATELY DIFFERENT IN WEIGHT.
 *
 * "Remove roles and permissions" is bookkeeping: it deletes the retired role
 * and permission rows and deactivates any account whose only roles were
 * retired. Nothing business-related is touched and a role can be granted again.
 *
 * "Delete the stored data" drops tables. It cannot be undone without a database
 * backup, so it needs a typed phrase rather than a click, and the button stays
 * disabled until that phrase matches exactly.
 */
export default function RetiredLeftoversTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState({});
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState("");
  const [result, setResult] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api.getRetiredLeftovers();
      setData(next);
      setError(null);
      // Pre-select the groups whose feature this release removed. "Earlier
      // retired features" is never pre-selected — it predates this work and
      // deserves its own decision.
      setSelected((current) => {
        if (Object.keys(current).length) return current;
        const seed = {};
        for (const group of next.groups || []) {
          if (group.key !== "earlier" && group.tables_present > 0) seed[group.key] = true;
        }
        return seed;
      });
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const chosen = Object.keys(selected).filter((k) => selected[k]);
  const phrase = data?.confirmation_phrase || "";
  const canDrop = chosen.length > 0 && confirm === phrase && !busy;

  const rowsChosen = (data?.groups || [])
    .filter((g) => selected[g.key])
    .reduce((sum, g) => sum + g.total_rows, 0);

  async function runPurgeConfig() {
    setBusy("config");
    setResult(null);
    try {
      const res = await api.purgeRetiredConfig();
      setResult({ kind: "config", res });
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy("");
    }
  }

  async function runDrop() {
    setBusy("drop");
    setResult(null);
    try {
      const res = await api.dropRetiredTables({ groups: chosen, confirm });
      setResult({ kind: "drop", res });
      setConfirm("");
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy("");
    }
  }

  if (loading && !data) return <div style={{ padding: 20, color: "#94a3b8" }}>Loading…</div>;

  return (
    <div>
      {error && (
        <PageFailure variant="inline" error={error} where="Retired feature leftovers" onRetry={load} />
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>What is still in the database</h3>
        <p style={{ color: "var(--text-muted)" }}>
          These features have been removed from the application. Their tables and
          permission rows were left in place so that no history was destroyed by a
          deploy. Nothing reads or writes them any more.
        </p>
      </div>

      {(data?.groups || []).map((group) => (
        <div className="card" key={group.key} style={{ marginBottom: 12 }}>
          <label style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={Boolean(selected[group.key])}
              disabled={group.tables_present === 0}
              onChange={(e) => setSelected((s) => ({ ...s, [group.key]: e.target.checked }))}
              style={{ marginTop: 4 }}
            />
            <span>
              <strong>{group.label}</strong>{" "}
              <span style={{ color: "var(--text-muted)", fontSize: 12 }}>removed {group.removed_at}</span>
              <div style={{ color: "var(--text-muted)", fontSize: 13, margin: "4px 0" }}>{group.note}</div>
              <div style={{ fontSize: 13 }}>
                {group.tables_present === 0
                  ? <span style={{ color: "#22c55e" }}>✓ nothing left — already clean</span>
                  : <>
                      <strong>{group.tables_present}</strong> table{group.tables_present === 1 ? "" : "s"},{" "}
                      <strong>{group.total_rows.toLocaleString()}</strong> row{group.total_rows === 1 ? "" : "s"}
                    </>}
              </div>
            </span>
          </label>
          {group.tables_present > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary style={{ cursor: "pointer", fontSize: 13, color: "var(--text-muted)" }}>
                Show tables
              </summary>
              <div className="table-container">
                <table className="table" style={{ marginTop: 8, fontSize: 13 }}>
                  <thead><tr><th>Table</th><th style={{ textAlign: "right" }}>Rows</th></tr></thead>
                  <tbody>
                    {group.tables.filter((t) => t.present).map((t) => (
                      <tr key={t.table}>
                        <td><code>{t.table}</code></td>
                        <td style={{ textAlign: "right" }}>{t.rows.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </div>
      ))}

      <div className="card" style={{ marginBottom: 12 }}>
        <h3 style={{ marginTop: 0 }}>Roles, permissions and accounts</h3>
        {(data?.rbac?.roles?.length || 0) === 0 && (data?.rbac?.permissions?.length || 0) === 0 ? (
          <p style={{ color: "#22c55e" }}>✓ No retired roles or permissions remain.</p>
        ) : (
          <>
            <p style={{ color: "var(--text-muted)" }}>
              {data.rbac.roles.length} retired role{data.rbac.roles.length === 1 ? "" : "s"} and{" "}
              {data.rbac.permissions.length} retired permission
              {data.rbac.permissions.length === 1 ? "" : "s"} are still defined.
              {data.rbac.accounts.length > 0 && (
                <> {data.rbac.accounts.length} account
                  {data.rbac.accounts.length === 1 ? "" : "s"} hold only retired roles
                  ({data.rbac.accounts.map((a) => a.username).join(", ")}) — they can still
                  sign in and have no page they can open.</>
              )}
            </p>
            <button className="btn btn-primary" onClick={runPurgeConfig} disabled={Boolean(busy)}>
              {busy === "config" ? "Removing…" : "Remove roles and permissions"}
            </button>
            <p style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 0 }}>
              Deactivates the accounts listed above rather than deleting them, so the
              audit log keeps resolving who did what. No business data is touched.
            </p>
          </>
        )}
      </div>

      <div className="card" style={{ borderLeft: "3px solid #ef4444" }}>
        <h3 style={{ marginTop: 0 }}>Delete the stored data</h3>
        <div className="alert alert-error">
          <strong>This cannot be undone.</strong> Dropping these tables permanently
          deletes every row in them — including trailer rental agreements, invoices
          and payment history, and the QBQ/SOS submissions.{" "}
          <strong>Take a database backup first.</strong>
        </div>
        <p style={{ color: "var(--text-muted)" }}>
          {chosen.length === 0
            ? "Select at least one group above."
            : <>Selected: <strong>{chosen.length}</strong> group{chosen.length === 1 ? "" : "s"},{" "}
              <strong>{rowsChosen.toLocaleString()}</strong> row{rowsChosen === 1 ? "" : "s"} will be deleted.</>}
        </p>
        <label style={{ display: "block", marginBottom: 8 }}>
          <span style={{ fontSize: 13 }}>Type <code>{phrase}</code> to confirm:</span>
          <input
            className="form-input"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder={phrase}
            autoComplete="off"
            spellCheck={false}
            style={{ marginTop: 4 }}
          />
        </label>
        <button className="btn btn-danger" onClick={runDrop} disabled={!canDrop}>
          {busy === "drop" ? "Deleting…" : "Delete the stored data permanently"}
        </button>
      </div>

      {result && (
        <div className="card" style={{ marginTop: 12 }}>
          <h3 style={{ marginTop: 0 }}>Done</h3>
          {result.kind === "config" ? (
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              <li>{result.res.deleted_roles.length} role(s) deleted{result.res.deleted_roles.length ? `: ${result.res.deleted_roles.join(", ")}` : ""}</li>
              <li>{result.res.deleted_permissions.length} permission(s) deleted</li>
              <li>{result.res.deactivated_accounts.length} account(s) deactivated{result.res.deactivated_accounts.length ? `: ${result.res.deactivated_accounts.map((a) => a.username).join(", ")}` : ""}</li>
            </ul>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              <li>{result.res.dropped.length} table(s) dropped{result.res.dropped.length ? `: ${result.res.dropped.join(", ")}` : ""}</li>
              <li>{result.res.already_absent.length} table(s) were already gone</li>
              {result.res.blocked.length > 0 && (
                <li style={{ color: "#ef4444" }}>
                  {result.res.blocked.length} table(s) could NOT be dropped because something
                  still references them — nothing was cascaded:
                  <ul>{result.res.blocked.map((b) => <li key={b.table}><code>{b.table}</code>: {b.reason}</li>)}</ul>
                </li>
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
