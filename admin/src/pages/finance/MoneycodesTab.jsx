import React, { useEffect, useState } from "react";
import * as api from "../../api";
import { money, when, DUPLICATE_REASON } from "./format";

/**
 * The money codes Wenze read with certainty.
 *
 * A REPEAT IS SHOWN, NEVER ACTED ON. Wenze does not issue money codes and
 * cannot recall one, so the strongest thing this screen does is put the two
 * rows next to each other and say which kind of repeat it is. The wording
 * matters: "this code was posted before" is a fact, "same amount to the same
 * person recently" is a suspicion, and the second one says so in the row.
 */
export default function MoneycodesTab() {
  const [rows, setRows] = useState([]);
  const [duplicatesOnly, setDuplicatesOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.listFinanceMoneycodes(duplicatesOnly)
      .then((d) => { if (!cancelled) { setRows(d.moneycodes || []); setError(null); } })
      .catch((e) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [duplicatesOnly]);

  if (loading) return <div className="loading"><div className="spinner"></div> Loading…</div>;
  if (error) return <div className="alert alert-error">{error}</div>;

  return (
    <div>
      <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
        <input
          type="checkbox"
          checked={duplicatesOnly}
          onChange={(e) => setDuplicatesOnly(e.target.checked)}
        />
        <span>Only show the ones flagged as repeats</span>
      </label>

      {rows.length === 0 ? (
        <div className="muted">Nothing here yet.</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr><th>Issued</th><th>Code</th><th>Amount</th><th>Posted by</th><th>Flagged</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{when(r.issuedAt)}</td>
                <td style={{ fontFamily: "monospace" }}>{r.code}</td>
                <td>{r.amount === null ? "—" : money(r.amount, r.currency)}</td>
                <td>{r.senderName || "—"}</td>
                <td>
                  {r.duplicateReason
                    ? DUPLICATE_REASON[r.duplicateReason] || r.duplicateReason
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
