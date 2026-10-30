import React from "react";
import RetentionTab from "./operations/RetentionTab";

/**
 * Drivers → Retention: who the company may be about to lose, and what to do
 * about it today.
 *
 * Its own page since October 2026. It was a tab of Needs Attention, but every
 * action on it is something a person does for a driver — ring them, answer the
 * request, pay the bonus, find them a load — not a disagreement between the
 * system's records, so it sits with the other driver work. The screen itself
 * is unchanged: ./operations/RetentionTab.jsx, and the rules about what may
 * never be shown are in docs/architecture/driver-retention.md.
 */
export default function RetentionPage() {
  const [status, setStatus] = React.useState(null);
  const flash = React.useCallback((type, text) => setStatus({ type, text }), []);
  return (
    <div>
      <div className="page-header">
        <h2>Driver Retention</h2>
        <p>
          Drivers the company may be about to lose, the reasons in what the company
          did or what the driver said, and the one thing to do about each today.
        </p>
      </div>
      {status && (
        <div className={`alert alert-${status.type}`} style={{ marginBottom: 12 }}>{status.text}</div>
      )}
      <RetentionTab flash={flash} />
    </div>
  );
}
