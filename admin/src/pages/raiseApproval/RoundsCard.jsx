import React from "react";

/**
 * Past review rounds, and one round's submissions split into the drivers each
 * dispatcher marked as earning the raised rate and those left at base.
 *
 * The Close button appears only while a round is open; closing invalidates its
 * dispatch link, so useRaiseRounds confirms first.
 *
 * Split out of admin/src/pages/RaiseApprovalPage.jsx.
 */
export function RoundsCard({
  rounds, viewRound, closeRound, selectedRound, roundResults,
}) {
  return (

  <div className="card">
    <h3>Past reviews</h3>
    <table className="table">
      <thead>
        <tr><th>Pay period</th><th>Status</th><th>Submissions</th><th></th></tr>
      </thead>
      <tbody>
        {rounds.map((r) => (
          <tr key={r.id}>
            <td>{r.period_start} → {r.period_end}</td>
            <td><span className="badge">{r.status}</span></td>
            <td>{r.submission_count}</td>
            <td style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
              <button className="btn btn-ghost btn-sm" onClick={() => viewRound(r)}>View</button>
              {r.status === "open" && (
                <button className="btn btn-ghost btn-sm" onClick={() => closeRound(r)}>Close</button>
              )}
            </td>
          </tr>
        ))}
        {rounds.length === 0 && (
          <tr><td colSpan={4} style={{ textAlign: "center", color: "#888" }}>No reviews yet.</td></tr>
        )}
      </tbody>
    </table>

    {selectedRound && roundResults && (
      <div style={{ marginTop: 16 }}>
        <h4>Results — {selectedRound.period_start} → {selectedRound.period_end}</h4>
        {roundResults.submissions.length === 0 && <p>No submissions yet.</p>}
        {roundResults.submissions.map((s) => (
          <div key={s.id} className="card" style={{ marginBottom: 12 }}>
            <strong>{s.team_name}</strong> — submitted by {s.dispatcher_name} ({s.dispatcher_contact})
            <div style={{ display: "flex", gap: 24, marginTop: 8, flexWrap: "wrap" }}>
              <div>
                <div style={{ color: "#16a34a", fontWeight: 600 }}>✅ Qualify (raised rate)</div>
                {s.picks.filter((p) => p.qualified).map((p) => <div key={p.id}>{p.driver_name}</div>)}
              </div>
              <div>
                <div style={{ color: "#dc2626", fontWeight: 600 }}>❌ Base rate</div>
                {s.picks.filter((p) => !p.qualified).map((p) => <div key={p.id}>{p.driver_name}</div>)}
              </div>
            </div>
          </div>
        ))}
      </div>
    )}
  </div>
  );
}
