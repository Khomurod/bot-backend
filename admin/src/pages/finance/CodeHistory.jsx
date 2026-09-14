import React, { useEffect, useState } from "react";
import * as api from "../../api";
import { when } from "./format";

/**
 * Everything that has happened to one money code, newest first.
 *
 * WHY THE TRAIL IS SHOWN AND NOT JUST THE STATE. "Voided" on a screen, with
 * nothing behind it, is something a person has to take on faith — and the
 * question actually asked during a reconciliation is not what the state is but
 * how it got there: which message did it, was it a rule or a model that read
 * that message, and how sure was it. That is what these rows answer.
 *
 * IT IS READ-ONLY, because the table is append-only. There is no control here
 * that changes a state, and there is no API route that would accept one.
 */
const EVENT_LABEL = {
  voided: "Voided",
  replaced: "Replaced by a later code",
  needs_review: "Handed to a person",
};

const DECIDED_BY = {
  deterministic: "read by the rules",
  ai: "read with a model's help — a person confirms it",
  admin: "recorded by a person",
};

export default function CodeHistory({ codeId }) {
  const [events, setEvents] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.listFinanceMoneycodeEvents(codeId)
      .then((d) => { if (!cancelled) { setEvents(d.events || []); setError(null); } })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [codeId]);

  if (error) return <div className="alert alert-error">{error}</div>;
  if (events === null) return <div className="muted">Reading the history…</div>;
  if (events.length === 0) {
    return <div className="muted">Nothing has changed since it was issued.</div>;
  }

  return (
    <ul style={{ margin: 0, paddingLeft: 18 }}>
      {events.map((e) => (
        <li key={e.id} style={{ marginBottom: 6 }}>
          <strong>{EVENT_LABEL[e.event] || e.event}</strong>
          {" — "}
          {when(e.createdAt)}
          <div className="muted" style={{ fontSize: 12 }}>
            {DECIDED_BY[e.decidedBy] || e.decidedBy}
            {e.confidence !== null && e.confidence !== undefined ? `, ${e.confidence}% sure` : ""}
            {e.note ? ` — ${e.note}` : ""}
          </div>
        </li>
      ))}
    </ul>
  );
}
