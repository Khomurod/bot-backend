import React, { useEffect, useState } from "react";
import * as api from "../api";

function fmtDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return iso;
  }
}

/** ISO datetime/date → YYYY-MM-DD for <input type="date">. */
function toDateInput(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
    return d.toISOString().slice(0, 10);
  } catch {
    return String(iso).slice(0, 10);
  }
}

export default function HomeTimePage() {
  const [settings, setSettings] = useState(null);
  const [statuses, setStatuses] = useState([]);
  const [history, setHistory] = useState([]);
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null);
  const [reg, setReg] = useState({ group_id: "", home_from: "", home_to: "", status: "approved", note: "" });
  const [importFiles, setImportFiles] = useState([]);
  const [importRows, setImportRows] = useState(null);
  const [importing, setImporting] = useState(false);
  const [applyingImport, setApplyingImport] = useState(false);

  const flash = (type, text) => setStatus({ type, text });

  const load = async () => {
    try {
      const [res, reqRes] = await Promise.all([
        api.getHomeTimeOverview(),
        api.getHomeTimeRequests().catch(() => ({ requests: [] })),
      ]);
      setSettings(res.settings);
      setStatuses(res.statuses || []);
      setHistory(res.history || []);
      setRequests(reqRes.requests || []);
    } catch (err) {
      flash("error", err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const saveSettings = async (patch) => {
    setSaving(true);
    setStatus(null);
    try {
      const res = await api.updateHomeTimeSettings(patch);
      setSettings(res.settings);
      flash("success", "Settings saved.");
    } catch (err) {
      flash("error", err.message);
    } finally {
      setSaving(false);
    }
  };

  const saveStatusSince = async (groupId, dateStr) => {
    setStatus(null);
    try {
      await api.updateHomeTimeStatusSince(groupId, dateStr);
      flash("success", "Start date updated.");
      await load();
    } catch (err) {
      flash("error", err.message);
    }
  };

  const saveTrip = async (id, road, home) => {
    setStatus(null);
    try {
      await api.updateHomeTimeTrip(id, { road_started_at: road, home_arrived_at: home });
      flash("success", "Trip dates updated.");
      await load();
    } catch (err) {
      flash("error", err.message);
    }
  };

  const removeTrip = async (id) => {
    if (!window.confirm("Delete this completed trip record?")) return;
    setStatus(null);
    try {
      await api.deleteHomeTimeTrip(id);
      flash("success", "Trip deleted.");
      await load();
    } catch (err) {
      flash("error", err.message);
    }
  };

  const registerRequest = async (e) => {
    e.preventDefault();
    setStatus(null);
    try {
      await api.createHomeTimeRequest({
        group_id: reg.group_id || null,
        home_from: reg.home_from,
        home_to: reg.home_to,
        status: reg.status,
        note: reg.note || null,
      });
      flash("success", "Home-time request registered.");
      setReg({ group_id: "", home_from: "", home_to: "", status: "approved", note: "" });
      await load();
    } catch (err) {
      flash("error", err.message);
    }
  };

  const readScreenshots = async () => {
    if (!importFiles.length) { flash("error", "Choose one or more screenshots first."); return; }
    setImporting(true);
    setStatus(null);
    setImportRows(null);
    try {
      const res = await api.importHomeTimeScreenshots(importFiles);
      const rows = (res.rows || []).map((r) => ({ ...r, _include: r.matched }));
      setImportRows(rows);
      flash("success", `Read ${res.total} drivers — ${res.matched} matched to groups, ${res.unmatched} unmatched.`);
    } catch (err) {
      flash("error", err.message);
    } finally {
      setImporting(false);
    }
  };

  const applyImport = async () => {
    const rows = (importRows || []).filter((r) => r._include && r.group_id);
    if (!rows.length) { flash("error", "No matched rows are selected to apply."); return; }
    setApplyingImport(true);
    setStatus(null);
    try {
      const report = await api.applyHomeTimeImport(rows);
      flash("success",
        `Applied: ${report.statusesUpdated} statuses set, ${report.historyAdded} home-times added`
        + `${report.historySkipped ? `, ${report.historySkipped} duplicates skipped` : ""}.`);
      setImportRows(null);
      setImportFiles([]);
      await load();
    } catch (err) {
      flash("error", err.message);
    } finally {
      setApplyingImport(false);
    }
  };

  if (loading) {
    return <div className="loading"><div className="spinner"></div> Loading...</div>;
  }

  const onRoad = statuses.filter((s) => s.state === "road");
  const atHome = statuses.filter((s) => s.state === "home");
  const overLimit = onRoad.filter((s) => s.over_limit);

  const STATUS_BADGE = {
    pending: { color: "#d97706", label: "Pending" },
    approved: { color: "#16a34a", label: "Approved" },
    denied: { color: "#dc2626", label: "Denied" },
    cancelled: { color: "#9ca3af", label: "Cancelled" },
  };

  return (
    <div>
      <div className="page-header">
        <h2>🏠 Driver Home Time</h2>
        <p>Tracks how long each driver is on the road vs. home, logs every home-time request, and the bonus earned for extra weeks out.</p>
      </div>

      {status && (
        <div className={`alert alert-${status.type}`} style={{ marginBottom: 16 }}>{status.text}</div>
      )}

      {/* ─── Import from screenshots ─── */}
      <div className="card" style={{ marginBottom: 20 }}>
        <h3>📸 Import from screenshots</h3>
        <p style={{ color: "#888", marginTop: 0 }}>
          Upload one or more screenshots of your home-time spreadsheet. AI reads every driver row — current status,
          the date they left/returned, and their home-time history — matches each to a driver group, and (after you
          review) fills the columns below.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            onChange={(e) => setImportFiles(Array.from(e.target.files || []))}
          />
          <button className="btn btn-primary" onClick={readScreenshots} disabled={importing || !importFiles.length}>
            {importing ? "Reading…" : "Read screenshots"}
          </button>
        </div>

        {importRows && (
          <div style={{ marginTop: 16 }}>
            <table className="table">
              <thead>
                <tr><th>Use</th><th>Name (from image)</th><th>Matched driver</th><th>Status</th><th>Since</th><th>History</th><th>Notes</th></tr>
              </thead>
              <tbody>
                {importRows.map((r, i) => (
                  <tr key={i} style={!r.matched ? { background: "rgba(220,38,38,0.06)" } : undefined}>
                    <td>
                      <input
                        type="checkbox"
                        checked={r._include && r.matched}
                        disabled={!r.matched}
                        onChange={(e) => {
                          const next = [...importRows];
                          next[i] = { ...next[i], _include: e.target.checked };
                          setImportRows(next);
                        }}
                      />
                    </td>
                    <td>{r.name}</td>
                    <td>{r.matched ? r.driver_label : <span style={{ color: "#dc2626" }}>— no match —</span>}</td>
                    <td>{r.status === "road" ? "🚚 Road" : r.status === "home" ? "🏠 Home" : "—"}</td>
                    <td>{r.since_date || "—"}</td>
                    <td>{r.history?.length ? `${r.history.length} period(s)` : "—"}</td>
                    <td style={{ maxWidth: 220, whiteSpace: "normal" }}>{r.notes || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="btn btn-primary" onClick={applyImport} disabled={applyingImport} style={{ marginTop: 8 }}>
              {applyingImport ? "Applying…" : `Apply ${importRows.filter((r) => r._include && r.group_id).length} matched rows`}
            </button>
          </div>
        )}
      </div>

      {/* ─── Settings ─── */}
      <div className="card" style={{ marginBottom: 20 }}>
        <h3>Settings</h3>
        {settings && (
          <div style={{ display: "grid", gap: 12, maxWidth: 520 }}>
            <label>
              <input
                type="checkbox"
                checked={settings.enabled}
                onChange={(e) => saveSettings({ enabled: e.target.checked })}
                disabled={saving}
              />{" "}
              Tracking enabled
            </label>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <div className="form-group">
                <label>Weeks allowed on the road</label>
                <input
                  type="number" min="1" max="52" defaultValue={settings.road_allowance_weeks}
                  onBlur={(e) => saveSettings({ road_allowance_weeks: Number(e.target.value) })}
                />
              </div>
              <div className="form-group">
                <label>Days allowed at home</label>
                <input
                  type="number" min="1" max="60" defaultValue={settings.home_allowance_days}
                  onBlur={(e) => saveSettings({ home_allowance_days: Number(e.target.value) })}
                />
              </div>
              <div className="form-group">
                <label>Bonus per extra week ($)</label>
                <input
                  type="number" min="0" step="1" defaultValue={settings.bonus_per_week}
                  onBlur={(e) => saveSettings({ bonus_per_week: Number(e.target.value) })}
                />
              </div>
            </div>
            <p style={{ color: "#888", margin: 0 }}>
              Policy: at least {settings.road_allowance_weeks} weeks on the road, then {settings.home_allowance_days} days home.
              A driver who stays out more than {settings.road_allowance_weeks} weeks earns
              ${Number(settings.bonus_per_week).toFixed(0)} for each full extra week. The clock resets each time they go home.
            </p>
          </div>
        )}
      </div>

      {/* ─── Live status ─── */}
      <div className="card" style={{ marginBottom: 20 }}>
        <h3>Right now</h3>
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginBottom: 12 }}>
          <div><strong>{onRoad.length}</strong> on the road</div>
          <div><strong>{atHome.length}</strong> home</div>
          <div style={{ color: overLimit.length ? "#dc2626" : "inherit" }}>
            <strong>{overLimit.length}</strong> over the limit (earning bonus)
          </div>
        </div>
        <p style={{ color: "#888", marginTop: 0 }}>
          Edit the "Since" date to correct when a driver left for the road or came home. The day counters recalculate from it.
        </p>
        <table className="table">
          <thead>
            <tr><th>Driver</th><th>Unit</th><th>Status</th><th>Since (editable)</th><th>Days</th><th>Bonus building</th></tr>
          </thead>
          <tbody>
            {statuses.map((s) => (
              <tr key={s.group_id} style={s.over_limit ? { background: "rgba(220,38,38,0.08)" } : undefined}>
                <td>{s.driver_name}</td>
                <td>{s.unit_number || "—"}</td>
                <td>
                  <span className={`badge ${s.state === "road" ? "" : "badge-muted"}`}>
                    {s.state === "road" ? "🚚 On the road" : "🏠 Home"}
                  </span>
                </td>
                <td>
                  <input
                    type="date"
                    defaultValue={toDateInput(s.state_since)}
                    max={new Date().toISOString().slice(0, 10)}
                    onChange={(e) => {
                      if (e.target.value) saveStatusSince(s.group_id, e.target.value);
                    }}
                  />
                </td>
                <td>{s.state === "road" ? `${s.days_on_road}d out` : `${s.days_home}d home`}</td>
                <td>
                  {s.state === "road" && s.over_limit
                    ? `${s.pending_exceeded_weeks} wk → $${Number(s.pending_bonus_usd).toFixed(0)}`
                    : "—"}
                </td>
              </tr>
            ))}
            {statuses.length === 0 && (
              <tr><td colSpan={6} style={{ textAlign: "center", color: "#888" }}>
                No statuses tracked yet. They appear once the update specialist posts "Status: Home / Ready / Rolling" in a driver group.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ─── Home-time requests ─── */}
      <div className="card" style={{ marginBottom: 20 }}>
        <h3>Home-time requests</h3>
        <p style={{ color: "#888", marginTop: 0 }}>
          Every request the bot handled (or you registered manually). Use this to spot drivers who don't follow the 4-weeks-on / 4-days-home policy.
        </p>

        <form onSubmit={registerRequest} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 16 }}>
          <div className="form-group">
            <label>Driver group</label>
            <select value={reg.group_id} onChange={(e) => setReg({ ...reg, group_id: e.target.value })}>
              <option value="">— select —</option>
              {statuses.map((s) => (
                <option key={s.group_id} value={s.group_id}>{s.driver_name}{s.unit_number ? ` (${s.unit_number})` : ""}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label>Home from</label>
            <input type="date" value={reg.home_from} onChange={(e) => setReg({ ...reg, home_from: e.target.value })} required />
          </div>
          <div className="form-group">
            <label>Home to</label>
            <input type="date" value={reg.home_to} onChange={(e) => setReg({ ...reg, home_to: e.target.value })} required />
          </div>
          <div className="form-group">
            <label>Status</label>
            <select value={reg.status} onChange={(e) => setReg({ ...reg, status: e.target.value })}>
              <option value="approved">Approved</option>
              <option value="denied">Denied</option>
              <option value="pending">Pending</option>
            </select>
          </div>
          <button className="btn btn-primary" type="submit">Register</button>
        </form>

        <table className="table">
          <thead>
            <tr><th>Driver</th><th>Unit</th><th>Requested</th><th>Home window</th><th>Days out</th><th>Policy</th><th>Status</th><th>Decided by</th><th>Source</th></tr>
          </thead>
          <tbody>
            {requests.map((r) => {
              const badge = STATUS_BADGE[r.status] || STATUS_BADGE.pending;
              return (
                <tr key={r.id} style={r.policy_met === false ? { background: "rgba(220,38,38,0.06)" } : undefined}>
                  <td>{r.driver_name || r.group_name || "—"}</td>
                  <td>{r.unit_number || "—"}</td>
                  <td>{fmtDate(r.requested_at)}</td>
                  <td>{r.home_from ? `${fmtDate(r.home_from)} → ${fmtDate(r.home_to)}` : "—"}</td>
                  <td>{r.days_on_road != null ? `${r.days_on_road}d` : "—"}</td>
                  <td>{r.policy_met === true ? "✅ met" : r.policy_met === false ? "⚠️ short" : "—"}</td>
                  <td style={{ color: badge.color, fontWeight: 600 }}>{badge.label}</td>
                  <td>{r.decided_by_username ? `@${r.decided_by_username}` : "—"}</td>
                  <td>{r.source}</td>
                </tr>
              );
            })}
            {requests.length === 0 && (
              <tr><td colSpan={9} style={{ textAlign: "center", color: "#888" }}>No home-time requests yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ─── Bonus history ─── */}
      <div className="card">
        <h3>Completed trips & bonuses</h3>
        <p style={{ color: "#888", marginTop: 0 }}>Edit the Left / Home dates to fix history; the bonus recalculates automatically.</p>
        <table className="table">
          <thead>
            <tr><th>Driver</th><th>Unit</th><th>Left</th><th>Home</th><th>Days out</th><th>Extra weeks</th><th>Bonus</th><th></th></tr>
          </thead>
          <tbody>
            {history.map((h) => (
              <tr key={h.id}>
                <td>{h.driver_name || h.group_name}</td>
                <td>{h.unit_number || "—"}</td>
                <td>
                  <input
                    type="date"
                    defaultValue={toDateInput(h.road_started_at)}
                    onChange={(e) => { h._road = e.target.value; }}
                  />
                </td>
                <td>
                  <input
                    type="date"
                    defaultValue={toDateInput(h.home_arrived_at)}
                    onChange={(e) => { h._home = e.target.value; }}
                  />
                </td>
                <td>{h.days_on_road}</td>
                <td>{h.exceeded_weeks}</td>
                <td style={{ fontWeight: Number(h.bonus_usd) > 0 ? 600 : 400, color: Number(h.bonus_usd) > 0 ? "#16a34a" : "inherit" }}>
                  ${Number(h.bonus_usd).toFixed(0)}
                </td>
                <td style={{ display: "flex", gap: 6 }}>
                  <button
                    className="btn btn-sm"
                    onClick={() => saveTrip(h.id, h._road || toDateInput(h.road_started_at), h._home || toDateInput(h.home_arrived_at))}
                  >Save</button>
                  <button className="btn btn-sm" style={{ color: "#dc2626" }} onClick={() => removeTrip(h.id)}>Delete</button>
                </td>
              </tr>
            ))}
            {history.length === 0 && (
              <tr><td colSpan={8} style={{ textAlign: "center", color: "#888" }}>No completed trips yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
