import React from "react";

/**
 * What a LEGACY `pending` home-time request looks like now.
 *
 * This slot used to hold Approve / Do Not Approve. Home time is no longer
 * approved: a stay is reported to the three managers as it happens, and a
 * completed request settles as `recorded`. No new request is ever written as
 * `pending`, so this note only ever appears on rows created before that change.
 *
 * It is deliberately a note and not a hidden element. A row that says "pending"
 * with nothing beside it reads as something waiting for you; saying plainly that
 * nothing is waiting is the whole job.
 */
export default function RetiredApprovalNote({ request }) {
  if (!request?.request_id || request.status !== "pending") return null;
  return (
    <div className="home-time-subtext" style={{ marginTop: 8 }}>
      Waiting for nobody — home time is no longer approved or declined. This request was
      created before that change; it is kept exactly as it was and needs no decision.
      New requests are recorded and reported to the managers as they happen.
    </div>
  );
}
