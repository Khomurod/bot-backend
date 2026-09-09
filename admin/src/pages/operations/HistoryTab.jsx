import React from "react";

import { checkLabel, correctionRows, formatWhen, initiatorLabel } from "./labels";

/**
 * Everything the system has changed, and the button that undoes it.
 *
 * This tab is also the first reader `admin_audit_log` has ever had. It was
 * created write-only and had accumulated rows nobody could see; every applied
 * correction mirrors into it inside the same transaction, so this is where that
 * finally becomes visible.
 *
 * A reverted correction is shown, struck through, rather than removed. The
 * trail is append-only on purpose: "this was done, then undone" is the honest
 * record and "this never happened" is not.
 */

function CorrectionRow({ correction, busy, onRevert }) {
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const rows = correctionRows(correction);
  const undone = Boolean(correction.revertedAt);

  return (
    <>
      <tr style={{ borderTop: "1px solid rgba(148,163,184,0.15)" }}>
        <td style={{ padding: "8px", fontSize: 12 }}>
          <div style={{ textDecoration: undone ? "line-through" : "none" }}>
            {correction.findingTitle || checkLabel(correction.checkKey) || correction.actionKey}
          </div>
          <div style={{ color: "#94a3b8", fontSize: 11 }}>
            {formatWhen(correction.appliedAt)} · {initiatorLabel(correction.initiator)}
            {correction.reason ? ` · “${correction.reason}”` : ""}
          </div>
          {undone && (
            <div style={{ color: "#f59e0b", fontSize: 11 }}>
              Reverted {formatWhen(correction.revertedAt)} by {correction.revertedBy}
              {correction.revertReason ? ` — “${correction.revertReason}”` : ""}
            </div>
          )}
        </td>
        <td style={{ padding: "8px", fontSize: 11, color: "#94a3b8", width: 160 }}>
          {correction.subjectType} #{correction.subjectId}
        </td>
        <td style={{ padding: "8px", width: 150, textAlign: "right" }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(!open)}>
            {open ? "Hide" : "What changed"}
          </button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={3} style={{ padding: "0 8px 12px 24px" }}>
            <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
              <tbody>
                <tr style={{ color: "#94a3b8" }}>
                  <td style={{ padding: "4px 8px" }}>Field</td>
                  <td style={{ padding: "4px 8px" }}>Was</td>
                  <td style={{ padding: "4px 8px" }}>Became</td>
                </tr>
                {rows.map((row) => (
                  <tr key={row.field}>
                    <td style={{ padding: "4px 8px" }}><code>{row.field}</code></td>
                    <td style={{ padding: "4px 8px", color: "#94a3b8" }}>{row.from}</td>
                    <td style={{ padding: "4px 8px" }}>{row.to}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!undone && (
              <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
                <input
                  className="form-input"
                  style={{ maxWidth: 320 }}
                  placeholder="Why are you undoing this?"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  disabled={busy}
                  onClick={() => onRevert(correction.id, reason.trim() || null)}
                >
                  Revert
                </button>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export default function HistoryTab({ corrections, summary, busy, revertCorrection }) {
  return (
    <div className="card">
      <div style={{ marginBottom: 8 }}>
        <strong>What has been changed</strong>
        <div style={{ color: "#94a3b8", fontSize: 12 }}>
          {summary?.corrections?.total ?? 0} in total ·{" "}
          {summary?.corrections?.live ?? 0} still in effect ·{" "}
          {summary?.corrections?.bySystem ?? 0} applied automatically from recorded evidence
        </div>
      </div>

      {corrections.length === 0 ? (
        <div className="empty-state">
          <div className="icon">📋</div>
          <h3>Nothing has been corrected yet</h3>
          <p>
            Every check ships disabled, so the system changes nothing until
            somebody grants it a specific permission on the Automation tab.
          </p>
        </div>
      ) : (
        <div className="table-container">
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <tbody>
              {corrections.map((correction) => (
                <CorrectionRow
                  key={correction.id}
                  correction={correction}
                  busy={busy}
                  onRevert={revertCorrection}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
