import React, { useState } from "react";
import { decideHomeTimeRequest } from "../api/homeTimeDecision";

/** YYYY-MM-DD from an ISO/date string or null. */
function dateOnly(value) {
  if (!value) return "";
  const m = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

/**
 * Approve / Do Not Approve actions for a PENDING home-time request, shown in the
 * driver activity timeline. Runs the SAME decision workflow as the Telegram
 * approval buttons via POST /home-time/requests/:id/decision, then reloads.
 *
 * - Renders nothing unless the request is still pending (already-decided requests
 *   show their final status + decided-by elsewhere in the timeline).
 * - Requires a simple inline confirmation so a decision is never one accidental
 *   click.
 * - Approve is blocked (with a hint) until the dates are present and consistent;
 *   the admin fixes them with the adjacent "Edit dates" control first. The server
 *   enforces the same rule authoritatively.
 */
export default function HomeTimeRequestDecision({ request, flash, onSaved }) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(null); // 'approve' | 'decline' | null

  const requestId = request?.request_id;
  if (!requestId || request.status !== "pending") return null;

  const from = dateOnly(request.home_from);
  const ret = dateOnly(request.return_to_road_date) || dateOnly(request.home_to);
  const datesReady = Boolean(from && ret && ret > from);

  const run = async (decision) => {
    setBusy(true);
    try {
      await decideHomeTimeRequest(requestId, decision);
      if (flash) flash("success", decision === "approve" ? "Home-time request approved." : "Home-time request declined.");
      setConfirming(null);
      if (onSaved) await onSaved();
    } catch (err) {
      if (flash) flash("error", err.message);
    } finally {
      setBusy(false);
    }
  };

  if (confirming) {
    const isApprove = confirming === "approve";
    return (
      <div className="home-time-action-row" style={{ marginTop: 8, alignItems: "center" }}>
        <span>{isApprove ? "Approve this home-time request?" : "Do not approve this request?"}</span>
        <button
          type="button"
          className={`btn btn-sm ${isApprove ? "btn-primary" : "btn-danger"}`}
          onClick={() => run(confirming)}
          disabled={busy}
        >
          {busy ? "Saving..." : isApprove ? "Yes, approve" : "Yes, do not approve"}
        </button>
        <button type="button" className="btn btn-sm" onClick={() => setConfirming(null)} disabled={busy}>
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="home-time-action-row" style={{ marginTop: 8, alignItems: "center" }}>
      <button
        type="button"
        className="btn btn-sm btn-primary"
        onClick={() => setConfirming("approve")}
        disabled={busy || !datesReady}
        title={datesReady ? "Approve this request" : "Set a valid arrive-home and return-to-road date first"}
      >
        Approve
      </button>
      <button type="button" className="btn btn-sm btn-danger" onClick={() => setConfirming("decline")} disabled={busy}>
        Do Not Approve
      </button>
      {!datesReady ? (
        <span className="home-time-subtext">Add the arrive-home and return-to-road dates to approve.</span>
      ) : null}
    </div>
  );
}
