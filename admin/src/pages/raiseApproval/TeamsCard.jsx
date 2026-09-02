import React from "react";

/**
 * The dispatch-teams table, plus the inline "add team" field.
 *
 * The Drivers and Members buttons open the same panel in its two modes. The
 * per-row counts are server-computed, which is why every mutation in
 * useRaiseTeams re-fetches the list rather than patching a row here.
 *
 * Split out of admin/src/pages/RaiseApprovalPage.jsx.
 */
export function TeamsCard({
  teams, newTeamName, setNewTeamName, createTeam,
  toggleTeamActive, deleteTeam, openDriverManager, openMembersManager,
}) {
  return (

  <div className="card" style={{ marginBottom: 20 }}>
    <h3>Dispatch teams</h3>
    <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
      <input
        placeholder="New team name (e.g. Team A — John)"
        value={newTeamName}
        onChange={(e) => setNewTeamName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && createTeam()}
        style={{ flex: 1 }}
      />
      <button className="btn btn-primary" onClick={createTeam}>Add team</button>
    </div>

    <table className="table">
      <thead>
        <tr><th>Team</th><th>Drivers</th><th>Members</th><th>Status</th><th></th></tr>
      </thead>
      <tbody>
        {teams.map((team) => (
          <tr key={team.id}>
            <td>{team.name}</td>
            <td>{team.driver_count}</td>
            <td>{team.member_count ?? 0}</td>
            <td>
              <span className={`badge ${team.active ? "" : "badge-muted"}`}>
                {team.active ? "Active" : "Inactive"}
              </span>
            </td>
            <td style={{ display: "flex", gap: 6, justifyContent: "flex-end", flexWrap: "wrap" }}>
              <button className="btn btn-ghost btn-sm" onClick={() => openDriverManager(team)}>Drivers</button>
              <button className="btn btn-ghost btn-sm" onClick={() => openMembersManager(team)}>Members</button>
              <button className="btn btn-ghost btn-sm" onClick={() => toggleTeamActive(team)}>
                {team.active ? "Disable" : "Enable"}
              </button>
              <button className="btn btn-danger btn-sm" onClick={() => deleteTeam(team)}>Delete</button>
            </td>
          </tr>
        ))}
        {teams.length === 0 && (
          <tr><td colSpan={5} style={{ textAlign: "center", color: "#888" }}>No teams yet.</td></tr>
        )}
      </tbody>
    </table>
  </div>
  );
}
