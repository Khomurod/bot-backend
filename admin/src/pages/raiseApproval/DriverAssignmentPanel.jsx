import React from "react";

/**
 * Assign company drivers to one dispatch team.
 *
 * Driver Groups are the source of truth for who exists, so the candidate list
 * is server-searched rather than filtered here, and each row SHOWS why a
 * driver may be unusable (no unit, no name, inactive group) instead of hiding
 * them — a missing unit number is something the admin has to go fix, not
 * something to make invisible.
 *
 * A driver can be on only one active team: assigning one who is already
 * assigned renders the conflict prompt, and only the explicit "Move to …"
 * button retries with force.
 *
 * Split out of admin/src/pages/RaiseApprovalPage.jsx.
 */
export function DriverAssignmentPanel({
  managingTeam, closePanel, pendingConflict, setPendingConflict,
  assignedDrivers, removeAssignedDriver,
  candidates, candidateSearch, setCandidateSearch, candidatesLoading,
  loadCandidates, assignCandidate,
}) {
  return (

  <div className="card" style={{ marginBottom: 20, border: "2px solid var(--primary, #6366f1)" }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <h3>Drivers — {managingTeam.name}</h3>
      <button className="btn btn-ghost btn-sm" onClick={closePanel}>Close</button>
    </div>
    <p style={{ color: "#888" }}>
      Drivers come from <strong>Driver Groups</strong> (the source of truth). A driver can
      belong to only one active team — assigning one already on another team asks you to move them.
    </p>

    {pendingConflict && (
      <div className="alert alert-warning" style={{ marginBottom: 12 }}>
        <strong>{pendingConflict.candidate.driver_name}</strong> is already assigned to{" "}
        <strong>{pendingConflict.conflictTeam?.name}</strong>.
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button className="btn btn-primary btn-sm" onClick={() => assignCandidate(pendingConflict.candidate, true)}>
            Move to {managingTeam.name}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => setPendingConflict(null)}>Cancel</button>
        </div>
      </div>
    )}

    <h4 style={{ marginBottom: 6 }}>Assigned drivers ({assignedDrivers.length})</h4>
    <div style={{ maxHeight: 220, overflowY: "auto", display: "grid", gap: 4, marginBottom: 16 }}>
      {assignedDrivers.map((d) => (
        <div key={d.id} style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between" }}>
          <span>
            {d.driver_name}
            {d.unit_number ? ` — Unit ${d.unit_number}` : ""}
            {d.needs_review && <span className="badge badge-muted" style={{ marginLeft: 8 }}>Needs review</span>}
            {!d.driver_profile_id && <span className="badge badge-muted" style={{ marginLeft: 8 }}>Legacy</span>}
          </span>
          <button className="btn btn-ghost btn-sm" onClick={() => removeAssignedDriver(d)}>Remove</button>
        </div>
      ))}
      {assignedDrivers.length === 0 && <p style={{ color: "#888" }}>No drivers assigned yet.</p>}
    </div>

    <h4 style={{ marginBottom: 6 }}>Add from Driver Groups</h4>
    <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
      <input
        placeholder="Search by name, unit, or group…"
        value={candidateSearch}
        onChange={(e) => setCandidateSearch(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && loadCandidates(candidateSearch)}
        style={{ flex: 1 }}
      />
      <button className="btn btn-ghost" onClick={() => loadCandidates(candidateSearch)} disabled={candidatesLoading}>
        {candidatesLoading ? "…" : "Search"}
      </button>
    </div>
    <div style={{ maxHeight: 340, overflowY: "auto", display: "grid", gap: 4 }}>
      {candidates.map((c) => {
        const onThisTeam = c.assigned_team_id === managingTeam.id;
        const onOtherTeam = c.assigned_team_id && !onThisTeam;
        return (
          <div key={c.group_id} style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between", padding: "2px 0" }}>
            <span style={{ flex: 1 }}>
              <strong>{c.driver_name || "(no name)"}</strong>
              {c.unit_number ? ` — Unit ${c.unit_number}` : ""}
              {c.driver_type ? ` — ${c.driver_type === "company_driver" ? "Company Driver" : c.driver_type}` : ""}
              <span style={{ color: "#888" }}>{c.group_name ? ` — ${c.group_name}` : ""}</span>
              {c.warnings?.includes("missing_unit") && <span className="badge badge-muted" style={{ marginLeft: 6 }}>no unit</span>}
              {c.warnings?.includes("missing_name") && <span className="badge badge-muted" style={{ marginLeft: 6 }}>no name</span>}
              {c.warnings?.includes("inactive_group") && <span className="badge badge-muted" style={{ marginLeft: 6 }}>inactive</span>}
              {onOtherTeam && <span className="badge" style={{ marginLeft: 6 }}>on {c.assigned_team_name}</span>}
            </span>
            {onThisTeam ? (
              <span className="badge">Assigned</span>
            ) : (
              <button className="btn btn-primary btn-sm" onClick={() => assignCandidate(c, false)}>
                {onOtherTeam ? "Move here" : "Assign"}
              </button>
            )}
          </div>
        );
      })}
      {candidates.length === 0 && !candidatesLoading && <p style={{ color: "#888" }}>No matching drivers.</p>}
    </div>
  </div>
  );
}
