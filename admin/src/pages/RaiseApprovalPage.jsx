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
  const [managingTeam, setManagingTeam] = useState(null); // team being assigned drivers
  const [driverList, setDriverList] = useState([]); // [{ driver_name }]
  const [newDriverName, setNewDriverName] = useState("");
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

  const openDriverManager = async (team) => {
    setStatus(null);
    try {
      const assigned = await api.getRaiseTeamDrivers(team.id);
      setDriverList((assigned.drivers || []).map((d) => ({ driver_name: d.driver_name })));
      setNewDriverName("");
      setManagingTeam(team);
    } catch (err) {
      flash("error", err.message);
    }
  };

  const addDriverToList = () => {
    const name = newDriverName.trim();
    if (!name) return;
    if (driverList.some((d) => d.driver_name.toLowerCase() === name.toLowerCase())) {
      return flash("error", "That driver is already in the list.");
    }
    setDriverList((prev) => [...prev, { driver_name: name }]);
    setNewDriverName("");
  };

  const removeDriverFromList = (idx) => {
    setDriverList((prev) => prev.filter((_, i) => i !== idx));
  };

  const saveAssignments = async () => {
    if (!managingTeam) return;
    try {
      await api.setRaiseTeamDrivers(managingTeam.id, driverList);
      const t = await api.getRaiseTeams();
      setTeams(t.teams || []);
      setManagingTeam(null);
      flash("success", "Driver list saved.");
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
          <h3>Drivers — {managingTeam.name}</h3>
          <p style={{ color: "#888" }}>
            Type each company driver this team is responsible for. Names are matched
            case- and spacing-insensitively when reading the weekly mileage report.
          </p>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <input
              placeholder="Driver full name (e.g. John Doe)"
              value={newDriverName}
              onChange={(e) => setNewDriverName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addDriverToList()}
              style={{ flex: 1 }}
            />
            <button className="btn btn-primary" onClick={addDriverToList}>Add</button>
          </div>
          <div style={{ maxHeight: 320, overflowY: "auto", display: "grid", gap: 4 }}>
            {driverList.map((d, idx) => (
              <div key={`${d.driver_name}-${idx}`} style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between" }}>
                <span>{d.driver_name}</span>
                <button className="btn btn-ghost btn-sm" onClick={() => removeDriverFromList(idx)}>Remove</button>
              </div>
            ))}
            {driverList.length === 0 && <p style={{ color: "#888" }}>No drivers added yet.</p>}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button className="btn btn-primary" onClick={saveAssignments}>Save driver list</button>
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
