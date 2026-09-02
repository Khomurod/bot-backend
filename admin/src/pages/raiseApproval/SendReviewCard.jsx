import React from "react";

/**
 * Send a review round to the employee group now.
 *
 * The two dates are all-or-nothing — a half-filled range is refused by
 * useRaiseRounds rather than defaulted, because silently judging a different
 * pay period than the admin intended is worse than an error message.
 *
 * Split out of admin/src/pages/RaiseApprovalPage.jsx.
 */
export function SendReviewCard({
  periodStart, setPeriodStart, periodEnd, setPeriodEnd, sending, sendNow, lastLink,
}) {
  return (

  <div className="card" style={{ marginBottom: 20 }}>
    <h3>Send a review now</h3>
    <p style={{ color: "#888" }}>Enter the week being judged, or leave blank to use last completed week.</p>
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
      <div className="form-group">
        <label>Period start</label>
        <input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
      </div>
      <div className="form-group">
        <label>Period end</label>
        <input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
      </div>
      <button className="btn btn-primary" onClick={sendNow} disabled={sending}>
        {sending ? "Sending…" : "Send to employee group"}
      </button>
    </div>
    {lastLink && (
      <p style={{ marginTop: 12 }}>
        Link: <a href={lastLink} target="_blank" rel="noreferrer">{lastLink}</a>
      </p>
    )}
  </div>
  );
}
