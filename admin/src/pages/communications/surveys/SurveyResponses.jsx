import React from "react";

import * as api from "../../../api";
import { relativeTime } from "../format";

/** The answers to one survey, loaded each time they are opened. */
export default function SurveyResponses({ questionId }) {
  const [responses, setResponses] = React.useState(null);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    let live = true;
    api.getResponses(questionId)
      .then((data) => { if (live) setResponses(Array.isArray(data) ? data : []); })
      .catch((err) => { if (live) setError(err?.message || "Could not load the answers."); });
    return () => { live = false; };
  }, [questionId]);

  if (error) return <div className="alert alert-error" style={{ marginTop: 16, marginBottom: 0 }}>{error}</div>;
  if (!responses) {
    return <div className="loading" style={{ padding: 20 }}><div className="spinner"></div> Loading answers…</div>;
  }
  if (responses.length === 0) {
    return (
      <div className="empty-state" style={{ padding: 32 }}>
        <h3>No answers yet</h3>
        <p>A driver&apos;s answer appears here when they tap a button under the survey.</p>
      </div>
    );
  }
  return (
    <div className="table-container" style={{ marginTop: 16 }}>
      <table>
        <thead>
          <tr><th>Driver</th><th>Group</th><th>Answer</th><th>Answered</th></tr>
        </thead>
        <tbody>
          {responses.map((r) => (
            <tr key={r.id}>
              <td>
                <strong>{r.first_name} {r.last_name}</strong>
                {r.username && <div style={{ fontSize: 11, color: "var(--text-muted)" }}>@{r.username}</div>}
              </td>
              <td>{r.group_name}</td>
              <td>{r.response_text}</td>
              <td style={{ whiteSpace: "nowrap" }}>{relativeTime(r.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
