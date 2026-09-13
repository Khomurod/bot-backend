import React, { useEffect, useState } from "react";
import * as api from "../../api";
import { money, when, REPORT_STATUS } from "./format";

/**
 * The weekly summaries that went out, and the ones that deliberately did not.
 *
 * `suppressed_backfill` IS SPELLED OUT IN WORDS. "Not sent — we were not
 * watching that week" and a genuinely quiet week are opposite answers, and
 * this table is the only place a person can tell them apart. A status code in
 * a column would technically be showing it and practically be hiding it.
 */
export default function ReportsTab() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.listFinanceReports()
      .then((d) => { if (!cancelled) { setRows(d.reports || []); setError(null); } })
      .catch((e) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  if (loading) return <div className="loading"><div className="spinner"></div> Loading…</div>;
  if (error) return <div className="alert alert-error">{error}</div>;
  if (rows.length === 0) return <div className="muted">No summaries have gone out yet.</div>;

  return (
    <table className="data-table">
      <thead>
        <tr><th>Week beginning</th><th>Result</th><th>Codes</th><th>Total</th><th>Sent</th></tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td>{new Date(r.periodStart).toLocaleDateString()}</td>
            <td>
              {REPORT_STATUS[r.status] || r.status}
              {r.error && <div className="muted" style={{ fontSize: 12 }}>{r.error}</div>}
            </td>
            <td>{r.totals?.codeCount ?? "—"}</td>
            <td>{r.totals ? money(r.totals.amountTotal) : "—"}</td>
            <td>{when(r.sentAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
