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

export default function HomeTimePage() {
  const [settings, setSettings] = useState(null);
  const [statuses, setStatuses] = useState([]);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null);

  const flash = (type, text) => setStatus({ type, text });

  const load = async () => {
    try {
      const res = await api.getHomeTimeOverview();
      setSettings(res.settings);
      setStatuses(res.statuses || []);
      setHistory(res.history || []);
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

  if (loading) {
    return <div className="loading"><div className="spinner"></div> Loading...</div>;
  }

  const onRoad = statuses.filter((s) => s.state === "road");
  const atHome = statuses.filter((s) => s.state === "home");
  const overLimit = onRoad.filter((s) => s.over_limit);

  return (
    <div>
      <div className="page-header">
        <h2>🏠 Driver Home Time</h2>
        <p>Tracks how long each driver is on the road vs. home, and the bonus earned for extra weeks out.</p>
      </div>

      {status && (
        <div className={`alert alert-${status.type}`} style={{ marginBottom: 16 }}>{status.text}</div>
      )}

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
        <table className="table">
          <thead>
            <tr><th>Driver</th><th>Unit</th><th>Status</th><th>Since</th><th>Days</th><th>Bonus building</th></tr>
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
                <td>{fmtDate(s.state_since)}</td>
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

      {/* ─── Bonus history ─── */}
      <div className="card">
        <h3>Completed trips & bonuses</h3>
        <table className="table">
          <thead>
            <tr><th>Driver</th><th>Unit</th><th>Left</th><th>Home</th><th>Days out</th><th>Extra weeks</th><th>Bonus</th></tr>
          </thead>
          <tbody>
            {history.map((h) => (
              <tr key={h.id}>
                <td>{h.driver_name || h.group_name}</td>
                <td>{h.unit_number || "—"}</td>
                <td>{fmtDate(h.road_started_at)}</td>
                <td>{fmtDate(h.home_arrived_at)}</td>
                <td>{h.days_on_road}</td>
                <td>{h.exceeded_weeks}</td>
                <td style={{ fontWeight: Number(h.bonus_usd) > 0 ? 600 : 400, color: Number(h.bonus_usd) > 0 ? "#16a34a" : "inherit" }}>
                  ${Number(h.bonus_usd).toFixed(0)}
                </td>
              </tr>
            ))}
            {history.length === 0 && (
              <tr><td colSpan={7} style={{ textAlign: "center", color: "#888" }}>No completed trips yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
