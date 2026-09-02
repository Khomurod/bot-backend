import React from "react";

/**
 * The dispatchers on one team.
 *
 * A member's Telegram username is what authorizes them to assign routes from
 * Telegram for this team's driver groups, so a member with no @username is
 * labelled as such rather than passing for complete.
 *
 * Split out of admin/src/pages/RaiseApprovalPage.jsx.
 */
export function TeamMembersPanel({
  managingTeam, closePanel, members, memberForm, setMemberForm,
  addMember, toggleMemberActive, removeMember,
}) {
  return (

  <div className="card" style={{ marginBottom: 20, border: "2px solid var(--primary, #6366f1)" }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <h3>Members — {managingTeam.name}</h3>
      <button className="btn btn-ghost btn-sm" onClick={closePanel}>Close</button>
    </div>
    <p style={{ color: "#888" }}>
      Dispatchers on this team. Their <strong>Telegram username</strong> authorizes them to
      assign routes from Telegram for this team's driver groups.
    </p>
    <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
      <input
        placeholder="Name"
        value={memberForm.name}
        onChange={(e) => setMemberForm((f) => ({ ...f, name: e.target.value }))}
        style={{ flex: "1 1 140px" }}
      />
      <input
        placeholder="@telegram_username"
        value={memberForm.telegram_username}
        onChange={(e) => setMemberForm((f) => ({ ...f, telegram_username: e.target.value }))}
        onKeyDown={(e) => e.key === "Enter" && addMember()}
        style={{ flex: "1 1 160px" }}
      />
      <select value={memberForm.role} onChange={(e) => setMemberForm((f) => ({ ...f, role: e.target.value }))}>
        <option value="">Role…</option>
        <option value="dispatcher">Dispatcher</option>
        <option value="lead_dispatcher">Lead dispatcher</option>
        <option value="manager">Manager</option>
      </select>
      <button className="btn btn-primary" onClick={addMember}>Add member</button>
    </div>
    <div style={{ maxHeight: 320, overflowY: "auto", display: "grid", gap: 4 }}>
      {members.map((m) => (
        <div key={m.id} style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between" }}>
          <span>
            {m.name || <em style={{ color: "#888" }}>(no name)</em>}
            {m.telegram_username ? ` — @${m.telegram_username}` : <span style={{ color: "#888" }}> — no @username</span>}
            {m.role ? <span className="badge badge-muted" style={{ marginLeft: 6 }}>{m.role.replace("_", " ")}</span> : null}
            {!m.active && <span className="badge badge-muted" style={{ marginLeft: 6 }}>inactive</span>}
          </span>
          <span style={{ display: "flex", gap: 6 }}>
            <button className="btn btn-ghost btn-sm" onClick={() => toggleMemberActive(m)}>
              {m.active ? "Disable" : "Enable"}
            </button>
            <button className="btn btn-danger btn-sm" onClick={() => removeMember(m)}>Remove</button>
          </span>
        </div>
      ))}
      {members.length === 0 && <p style={{ color: "#888" }}>No members yet.</p>}
    </div>
  </div>
  );
}
