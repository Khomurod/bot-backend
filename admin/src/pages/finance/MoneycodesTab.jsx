import React, { useEffect, useState } from "react";
import * as api from "../../api";
import { money, when, DUPLICATE_REASON } from "./format";
import CodeHistory from "./CodeHistory";

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
  const [openId, setOpenId] = useState(null);
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
            <tr>
              <th>Issued</th><th>Code</th><th>Amount</th><th>State</th>
              <th>Issued to</th><th>Posted by</th><th>Flagged</th><th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <React.Fragment key={r.id}>
              <tr style={r.status === "voided" ? { opacity: 0.65 } : undefined}>
                <td>{when(r.issuedAt)}</td>
                <td style={{
                  fontFamily: "monospace",
                  textDecoration: r.status === "voided" ? "line-through" : undefined,
                }}
                >
                  {r.code}
                </td>
                <td>{r.amount === null ? "—" : money(r.amount, r.currency)}</td>
                {/* A VOIDED CODE STAYS IN THIS LIST. Hiding it would make the
                    history disagree with the totals, and "where did that code
                    go" is the question this screen exists to answer. */}
                <td><CodeState row={r} /></td>
                <td>{r.issuedTo || "—"}</td>
                <td>{r.senderName || "—"}</td>
                <td>
                  {r.duplicateReason
                    ? DUPLICATE_REASON[r.duplicateReason] || r.duplicateReason
                    : "—"}
                </td>
                <td>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setOpenId(openId === r.id ? null : r.id)}
                  >
                    {openId === r.id ? "Hide history" : "History"}
                  </button>
                </td>
              </tr>
              {openId === r.id ? (
                <tr>
                  <td colSpan={8} style={{ background: "var(--bg-secondary)" }}>
                    <CodeHistory codeId={r.id} />
                  </td>
                </tr>
              ) : null}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * What state this code is in, and — for a void — on what evidence.
 *
 * The evidence is shown rather than kept in the database only. "Why is this
 * voided" asked six weeks later is answered here, which is the whole reason the
 * link is stored with a reason attached to it.
 */
const STATE_LABEL = {
  active: "Active",
  voided: "Voided",
  replaced: "Replaced",
  needs_review: "Needs a person",
  duplicate_posting: "Posted again",
};

const VOID_EVIDENCE = {
  named: "the message named this code",
  replied_to: "a reply to the message that issued it",
  named_and_replied: "named, and a reply to the message that issued it",
  only_active_code_in_scope: "the only active code in the conversation at the time",
};

function CodeState({ row }) {
  const label = STATE_LABEL[row.status] || row.status || "Active";
  if (row.status !== "voided") {
    return (
      <span>
        {label}
        {row.status === "needs_review" && row.reviewReason
          ? <div className="muted" style={{ fontSize: 12 }}>{row.reviewReason}</div>
          : null}
      </span>
    );
  }
  const how = VOID_EVIDENCE[row.voidEvidence?.kind] || row.voidEvidence?.kind || null;
  return (
    <span>
      {label}
      <div className="muted" style={{ fontSize: 12 }}>
        {when(row.voidedAt)}
        {how ? ` — ${how}` : ""}
      </div>
    </span>
  );
}
