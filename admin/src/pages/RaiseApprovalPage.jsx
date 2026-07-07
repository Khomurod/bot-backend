import React, { useState, useEffect } from "react";
import * as api from "../api";

const WEEKDAYS = [
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
  { value: 7, label: "Sunday" },
];

export default function RaiseApprovalPage() {
  const [settings, setSettings] = useState(null);
  const [scheduleDescription, setScheduleDescription] = useState("");
  const [teams, setTeams] = useState([]);
  const [rounds, setRounds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [newTeamName, setNewTeamName] = useState("");
  const [managingTeam, setManagingTeam] = useState(null); // team being managed
  const [panelMode, setPanelMode] = useState(null); // 'drivers' | 'members'
  const [assignedDrivers, setAssignedDrivers] = useState([]); // team's current drivers
  const [candidates, setCandidates] = useState([]); // assignable drivers (Driver Groups)
  const [candidateSearch, setCandidateSearch] = useState("");
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [pendingConflict, setPendingConflict] = useState(null); // { candidate, conflictTeam }
  const [members, setMembers] = useState([]);
  const [memberForm, setMemberForm] = useState({ name: "", telegram_username: "", role: "" });
  const [gmailUser, setGmailUser] = useState("");
  const [gmailPassword, setGmailPassword] = useState("");
  const [savingGmail, setSavingGmail] = useState(false);
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [sending, setSending] = useState(false);
  const [lastLink, setLastLink] = useState("");
  const [selectedRound, setSelectedRound] = useState(null);
  const [roundResults, setRoundResults] = useState(null);

  const flash = (type, text) => setStatus({ type, text });

  const loadAll = async () => {
    try {
      const [s, t, r] = await Promise.all([
        api.getRaiseSettings(),
        api.getRaiseTeams(),
        api.getRaiseRounds(),
      ]);
      setSettings(s.settings);
      setScheduleDescription(s.scheduleDescription);
      setGmailUser(s.settings.gmail_user || "");
      setTeams(t.teams || []);
      setRounds(r.rounds || []);
    } catch (err) {
      flash("error", err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadAll(); }, []);

  const saveSettings = async (patch) => {
    setSavingSettings(true);
    setStatus(null);
    try {
      const res = await api.updateRaiseSettings(patch);
      setSettings(res.settings);
      setScheduleDescription(res.scheduleDescription);
      flash("success", "Settings saved.");
    } catch (err) {
      flash("error", err.message);
    } finally {
      setSavingSettings(false);
    }
  };

  const handleCreateTeam = async () => {
    const name = newTeamName.trim();
    if (!name) return;
    try {
      await api.createRaiseTeam(name);
      setNewTeamName("");
      const t = await api.getRaiseTeams();
      setTeams(t.teams || []);
      flash("success", `Team "${name}" created.`);
    } catch (err) {
      flash("error", err.message);
    }
  };

  const toggleTeamActive = async (team) => {
    try {
      await api.updateRaiseTeam(team.id, { active: !team.active });
      const t = await api.getRaiseTeams();
      setTeams(t.teams || []);
    } catch (err) {
      flash("error", err.message);
    }
  };

  const handleDeleteTeam = async (team) => {
    if (!window.confirm(`Delete team "${team.name}"? This removes its driver assignments.`)) return;
    try {
      await api.deleteRaiseTeam(team.id);
      const t = await api.getRaiseTeams();
      setTeams(t.teams || []);
      flash("success", "Team deleted.");
    } catch (err) {
      flash("error", err.message);
    }
  };

  const saveGmail = async () => {
    if (!gmailUser.trim()) return flash("error", "Enter your Gmail address.");
    setSavingGmail(true);
    setStatus(null);
    try {
      const res = await api.updateRaiseSettings({
        gmail_user: gmailUser.trim(),
        ...(gmailPassword.trim() ? { gmail_app_password: gmailPassword.trim() } : {}),
      });
      setSettings(res.settings);
      setScheduleDescription(res.scheduleDescription);
      setGmailPassword("");
      flash("success", "Email settings saved.");
    } catch (err) {
      flash("error", err.message);
    } finally {
      setSavingGmail(false);
    }
  };

  const refreshTeams = async () => {
    const t = await api.getRaiseTeams();
    setTeams(t.teams || []);
  };

  const loadCandidates = async (search = "") => {
    setCandidatesLoading(true);
    try {
      const res = await api.getRaiseAssignableDrivers({ search });
      setCandidates(res.drivers || []);
    } catch (err) {
      flash("error", err.message);
    } finally {
      setCandidatesLoading(false);
    }
  };

  const openDriverManager = async (team) => {
    setStatus(null);
    setPendingConflict(null);
    try {
      const assigned = await api.getRaiseTeamDrivers(team.id);
      setAssignedDrivers(assigned.drivers || []);
      setManagingTeam(team);
      setPanelMode("drivers");
      setCandidateSearch("");
      await loadCandidates("");
    } catch (err) {
      flash("error", err.message);
    }
  };

  const refreshDriverPanel = async () => {
    if (!managingTeam) return;
    const assigned = await api.getRaiseTeamDrivers(managingTeam.id);
    setAssignedDrivers(assigned.drivers || []);
    await loadCandidates(candidateSearch);
    await refreshTeams();
  };

  const assignCandidate = async (candidate, force = false) => {
    if (!managingTeam) return;
    try {
      const res = await api.assignRaiseDriver(managingTeam.id, {
        groupId: candidate.group_id,
        driverProfileId: candidate.driver_profile_id,
        force,
      });
      if (res.conflict) {
        setPendingConflict({ candidate, conflictTeam: res.conflictTeam });
        return;
      }
      setPendingConflict(null);
      await refreshDriverPanel();
      flash("success", res.moved
        ? `Moved ${candidate.driver_name} to ${managingTeam.name}.`
        : `Assigned ${candidate.driver_name}.`);
    } catch (err) {
      flash("error", err.message);
    }
  };

  const removeAssignedDriver = async (driver) => {
    try {
      await api.removeRaiseTeamDriver(driver.id);
      await refreshDriverPanel();
      flash("success", `Removed ${driver.driver_name}.`);
    } catch (err) {
      flash("error", err.message);
    }
  };

  const openMembersManager = async (team) => {
    setStatus(null);
    try {
      const res = await api.getRaiseTeamMembers(team.id);
      setMembers(res.members || []);
      setMemberForm({ name: "", telegram_username: "", role: "" });
      setManagingTeam(team);
      setPanelMode("members");
    } catch (err) {
      flash("error", err.message);
    }
  };

  const refreshMembers = async () => {
    if (!managingTeam) return;
    const res = await api.getRaiseTeamMembers(managingTeam.id);
    setMembers(res.members || []);
    await refreshTeams();
  };

  const addMember = async () => {
    if (!managingTeam) return;
    if (!memberForm.name.trim() && !memberForm.telegram_username.trim()) {
      return flash("error", "Enter a name or a Telegram username.");
    }
    try {
      await api.createRaiseTeamMember(managingTeam.id, {
        name: memberForm.name.trim() || null,
        telegramUsername: memberForm.telegram_username.trim() || null,
        role: memberForm.role || null,
      });
      setMemberForm({ name: "", telegram_username: "", role: "" });
      await refreshMembers();
      flash("success", "Member added.");
    } catch (err) {
      flash("error", err.message);
    }
  };

  const toggleMemberActive = async (member) => {
    try {
      await api.updateRaiseTeamMember(member.id, { active: !member.active });
      await refreshMembers();
    } catch (err) {
      flash("error", err.message);
    }
  };

  const removeMember = async (member) => {
    if (!window.confirm("Remove this team member?")) return;
    try {
      await api.deleteRaiseTeamMember(member.id);
      await refreshMembers();
      flash("success", "Member removed.");
    } catch (err) {
      flash("error", err.message);
    }
  };

  const closePanel = () => {
    setManagingTeam(null);
    setPanelMode(null);
    setPendingConflict(null);
  };

  const handleSendNow = async () => {
    if ((periodStart && !periodEnd) || (!periodStart && periodEnd)) {
      flash("error", "Enter both period dates, or leave both blank to use last week.");
      return;
    }
    setSending(true);
    setStatus(null);
    setLastLink("");
    try {
      const res = await api.raiseSendNow({ periodStart: periodStart || null, periodEnd: periodEnd || null });
      setLastLink(res.link || "");
      const r = await api.getRaiseRounds();
      setRounds(r.rounds || []);
      flash("success", "Review sent to the employee group.");
    } catch (err) {
      flash("error", err.message);
    } finally {
      setSending(false);
    }
  };

  const viewRound = async (round) => {
    setSelectedRound(round);
    setRoundResults(null);
    try {
      const res = await api.getRaiseRoundResults(round.id);
      setRoundResults(res);
    } catch (err) {
      flash("error", err.message);
    }
  };

  const handleCloseRound = async (round) => {
    if (!window.confirm("Close this round? The dispatch link will stop working.")) return;
    try {
      await api.closeRaiseRound(round.id);
      const r = await api.getRaiseRounds();
      setRounds(r.rounds || []);
      flash("success", "Round closed.");
    } catch (err) {
      flash("error", err.message);
    }
  };

  if (loading) {
    return <div className="loading"><div className="spinner"></div> Loading...</div>;
  }

  return (
    <div>
      <div className="page-header">
        <h2>💵 Driver Raises (75¢/mile)</h2>
        <p>Ask dispatch teams which company drivers earned the higher rate this pay period.</p>
      </div>

      {status && (
        <div className={`alert alert-${status.type}`} style={{ marginBottom: 16 }}>{status.text}</div>
      )}

      {/* ─── Settings ─── */}
      <div className="card" style={{ marginBottom: 20 }}>
        <h3>Settings</h3>
        {settings && (
          <div style={{ display: "grid", gap: 12, maxWidth: 560 }}>
            <label>
              <input
                type="checkbox"
                checked={settings.enabled}
                onChange={(e) => saveSettings({ enabled: e.target.checked })}
                disabled={savingSettings}
              />{" "}
              Service enabled
            </label>

            <div className="form-group">
              <label>Verification code is sent by</label>
              <select
                value={settings.otp_channel}
                onChange={(e) => saveSettings({ otp_channel: e.target.value })}
                disabled={savingSettings}
              >
                <option value="gmail">Email (your Gmail)</option>
                <option value="ringcentral">Text message (RingCentral SMS)</option>
              </select>
            </div>

            {settings.otp_channel === "gmail" && (
              <div style={{ border: "1px solid var(--border, #333)", borderRadius: 8, padding: 12, display: "grid", gap: 8 }}>
                <div style={{ fontWeight: 600 }}>
                  Gmail credentials{" "}
                  <span style={{ fontWeight: 400, color: settings.gmail_configured ? "#16a34a" : "#dc2626" }}>
                    {settings.gmail_configured ? "— configured ✓" : "— not configured"}
                  </span>
                </div>
                <p style={{ color: "#888", margin: 0 }}>
                  Use a Gmail <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">App Password</a> (not
                  your normal password). The password is encrypted before it is stored.
                </p>
                <div className="form-group">
                  <label>Gmail address</label>
                  <input
                    type="email"
                    placeholder="dispatch@company.com"
                    value={gmailUser}
                    onChange={(e) => setGmailUser(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label>App Password</label>
                  <input
                    type="password"
                    placeholder={settings.gmail_configured ? "Leave blank to keep current" : "16-character App Password"}
                    value={gmailPassword}
                    onChange={(e) => setGmailPassword(e.target.value)}
                    autoComplete="new-password"
                  />
                </div>
                <div>
                  <button className="btn btn-primary" onClick={saveGmail} disabled={savingGmail}>
                    {savingGmail ? "Saving…" : "Save email settings"}
                  </button>
                </div>
              </div>
            )}

            <label>
              <input
                type="checkbox"
                checked={settings.schedule_enabled}
                onChange={(e) => saveSettings({ schedule_enabled: e.target.checked })}
                disabled={savingSettings}
              />{" "}
              Auto-send on a weekly schedule
            </label>

            {settings.schedule_enabled && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <select
                  value={settings.weekly_day_of_week}
                  onChange={(e) => saveSettings({ weekly_day_of_week: Number(e.target.value) })}
                  disabled={savingSettings}
                >
                  {WEEKDAYS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
                </select>
                <input
                  type="time"
                  value={settings.weekly_time_local}
                  onChange={(e) => saveSettings({ weekly_time_local: e.target.value })}
                  disabled={savingSettings}
                />
                <span style={{ color: "var(--muted, #888)" }}>{scheduleDescription}</span>
              </div>
            )}

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <div className="form-group">
                <label>Base rate ($/mile)</label>
                <input
                  type="number" step="0.01" defaultValue={settings.rate_low}
                  onBlur={(e) => saveSettings({ rate_low: Number(e.target.value) })}
                />
              </div>
              <div className="form-group">
                <label>Raised rate ($/mile)</label>
                <input
                  type="number" step="0.01" defaultValue={settings.rate_high}
                  onBlur={(e) => saveSettings({ rate_high: Number(e.target.value) })}
                />
              </div>
              <div className="form-group">
                <label>Link expires after (hours)</label>
                <input
                  type="number" min="1" max="720" defaultValue={settings.link_ttl_hours}
                  onBlur={(e) => saveSettings({ link_ttl_hours: Number(e.target.value) })}
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ─── Dispatch teams ─── */}
      <div className="card" style={{ marginBottom: 20 }}>
        <h3>Dispatch teams</h3>
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <input
            placeholder="New team name (e.g. Team A — John)"
            value={newTeamName}
            onChange={(e) => setNewTeamName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreateTeam()}
            style={{ flex: 1 }}
          />
          <button className="btn btn-primary" onClick={handleCreateTeam}>Add team</button>
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
                  <button className="btn btn-danger btn-sm" onClick={() => handleDeleteTeam(team)}>Delete</button>
                </td>
              </tr>
            ))}
            {teams.length === 0 && (
              <tr><td colSpan={5} style={{ textAlign: "center", color: "#888" }}>No teams yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ─── Driver assignment panel (source of truth: Driver Groups) ─── */}
      {managingTeam && panelMode === "drivers" && (
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
      )}

      {/* ─── Team members panel ─── */}
      {managingTeam && panelMode === "members" && (
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
      )}

      {/* ─── Send now ─── */}
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
          <button className="btn btn-primary" onClick={handleSendNow} disabled={sending}>
            {sending ? "Sending…" : "Send to employee group"}
          </button>
        </div>
        {lastLink && (
          <p style={{ marginTop: 12 }}>
            Link: <a href={lastLink} target="_blank" rel="noreferrer">{lastLink}</a>
          </p>
        )}
      </div>

      {/* ─── Rounds + results ─── */}
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
                    <button className="btn btn-ghost btn-sm" onClick={() => handleCloseRound(r)}>Close</button>
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
    </div>
  );
}
