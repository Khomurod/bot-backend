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
  const [candidates, setCandidates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [newTeamName, setNewTeamName] = useState("");
  const [managingTeam, setManagingTeam] = useState(null); // team being assigned drivers
  const [assignSelection, setAssignSelection] = useState(new Set());
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

  const openDriverManager = async (team) => {
    setStatus(null);
    try {
      const [cand, assigned] = await Promise.all([
        candidates.length ? Promise.resolve({ drivers: candidates }) : api.getRaiseCompanyDrivers(),
        api.getRaiseTeamDrivers(team.id),
      ]);
      if (!candidates.length) setCandidates(cand.drivers || []);
      setAssignSelection(new Set((assigned.drivers || []).map((d) => d.driver_normalized_name)));
      setManagingTeam(team);
    } catch (err) {
      flash("error", err.message);
    }
  };

  const toggleAssign = (normName) => {
    setAssignSelection((prev) => {
      const next = new Set(prev);
      if (next.has(normName)) next.delete(normName); else next.add(normName);
      return next;
    });
  };

  const saveAssignments = async () => {
    if (!managingTeam) return;
    const drivers = candidates.filter((c) => assignSelection.has(c.driver_normalized_name));
    try {
      await api.setRaiseTeamDrivers(managingTeam.id, drivers);
      const t = await api.getRaiseTeams();
      setTeams(t.teams || []);
      setManagingTeam(null);
      flash("success", "Driver assignments saved.");
    } catch (err) {
      flash("error", err.message);
    }
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
            <tr><th>Team</th><th>Drivers</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {teams.map((team) => (
              <tr key={team.id}>
                <td>{team.name}</td>
                <td>{team.driver_count}</td>
                <td>
                  <span className={`badge ${team.active ? "" : "badge-muted"}`}>
                    {team.active ? "Active" : "Inactive"}
                  </span>
                </td>
                <td style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => openDriverManager(team)}>Drivers</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => toggleTeamActive(team)}>
                    {team.active ? "Disable" : "Enable"}
                  </button>
                  <button className="btn btn-danger btn-sm" onClick={() => handleDeleteTeam(team)}>Delete</button>
                </td>
              </tr>
            ))}
            {teams.length === 0 && (
              <tr><td colSpan={4} style={{ textAlign: "center", color: "#888" }}>No teams yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ─── Driver assignment modal ─── */}
      {managingTeam && (
        <div className="card" style={{ marginBottom: 20, border: "2px solid var(--primary, #6366f1)" }}>
          <h3>Assign company drivers — {managingTeam.name}</h3>
          <p style={{ color: "#888" }}>Tick the active company drivers this team is responsible for.</p>
          <div style={{ maxHeight: 320, overflowY: "auto", display: "grid", gap: 4 }}>
            {candidates.map((c) => (
              <label key={c.driver_normalized_name} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={assignSelection.has(c.driver_normalized_name)}
                  onChange={() => toggleAssign(c.driver_normalized_name)}
                />
                {c.driver_name}
              </label>
            ))}
            {candidates.length === 0 && <p>No company drivers found in Datatruck.</p>}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button className="btn btn-primary" onClick={saveAssignments}>Save assignments</button>
            <button className="btn btn-ghost" onClick={() => setManagingTeam(null)}>Cancel</button>
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
