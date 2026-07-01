import React, { useState, useEffect, useCallback, useMemo } from "react";
import * as api from "../api";

const PHASE_LABEL = {
  heading_pickup: "→ Shipper (pickup)",
  heading_delivery: "→ Receiver (delivery)",
  unknown: "Determining…",
};

const STATUS_PILL = {
  tracking: "info",
  checkin_sent: "info",
  awaiting_checkin: "info",
  checked_in_shipper: "success",
  checked_in_receiver: "success",
  checked_out_shipper: "success",
  checked_out_receiver: "success",
  already_prompted: "neutral",
  no_load: "neutral",
  no_location: "neutral",
  no_coords: "neutral",
  error: "danger",
};

function formatDateTime(iso, { future = false } = {}) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  if (future) return d.toLocaleString();
  return d.toLocaleString();
}

function formatEtaMinutes(mins) {
  if (mins == null || !Number.isFinite(Number(mins))) return "—";
  const m = Math.max(0, Math.round(Number(mins)));
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h > 0 ? `${h}h ${r}m` : `${r}m`;
}

function Toggle({ on, disabled, onClick, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "8px",
        border: "none",
        background: "transparent",
        color: "var(--text-secondary)",
        cursor: disabled ? "not-allowed" : "pointer",
        padding: 0,
      }}
    >
      <span
        style={{
          width: "42px",
          height: "24px",
          borderRadius: "999px",
          background: on ? "var(--success)" : "var(--border)",
          position: "relative",
          transition: "background 150ms ease",
          opacity: disabled ? 0.7 : 1,
        }}
      >
        <span
          style={{
            position: "absolute",
            top: "3px",
            left: on ? "21px" : "3px",
            width: "18px",
            height: "18px",
            borderRadius: "50%",
            background: "#fff",
            boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
            transition: "left 150ms ease",
          }}
        />
      </span>
      {on ? "On" : "Off"}
    </button>
  );
}

export default function LocationMonitorPage() {
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState(null);
  const [savingGroupId, setSavingGroupId] = useState(null);
  const [bulkSaving, setBulkSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [expandedGroupId, setExpandedGroupId] = useState(null);
  const [checkinsByGroup, setCheckinsByGroup] = useState({});
  const [checkinsLoadingId, setCheckinsLoadingId] = useState(null);
  const [defaultInterval, setDefaultInterval] = useState(30);
  const [defaultRadius, setDefaultRadius] = useState(8);

  const fetchGroups = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getLocationMonitors();
      setGroups(Array.isArray(data?.groups) ? data.groups : []);
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchGroups();
  }, [fetchGroups]);

  const displayGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = [...groups].sort((a, b) =>
      String(a.driver_name || a.group_name || "").localeCompare(
        String(b.driver_name || b.group_name || "")
      )
    );
    if (!q) return list;
    return list.filter((g) =>
      [g.driver_name, g.group_name, g.unit_number]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q))
    );
  }, [groups, search]);

  const enabledCount = useMemo(
    () => groups.filter((g) => g.enabled).length,
    [groups]
  );

  const handleToggle = async (row, nextEnabled) => {
    setSavingGroupId(row.group_id);
    setMessage(null);
    try {
      const res = await api.updateLocationMonitor(row.group_id, {
        enabled: nextEnabled,
        intervalMinutes: row.interval_minutes || defaultInterval,
        checkinRadiusMiles: row.checkin_radius_miles || defaultRadius,
      });
      const saved = res?.setting;
      if (saved) {
        setGroups((cur) => cur.map((g) => (g.group_id === row.group_id ? { ...g, ...saved } : g)));
      } else {
        await fetchGroups();
      }
      if (nextEnabled) {
        const reason = res?.immediate?.reason;
        setMessage({
          type: "success",
          text: `Location monitoring enabled for ${row.driver_name || row.group_name}.${
            reason ? ` First check: ${reason.replace(/_/g, " ")}.` : ""
          }`,
        });
      } else {
        setMessage({ type: "success", text: `Location monitoring disabled for ${row.driver_name || row.group_name}.` });
      }
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setSavingGroupId(null);
    }
  };

  const handleSaveConfig = async (row, patch) => {
    setSavingGroupId(row.group_id);
    setMessage(null);
    try {
      const res = await api.updateLocationMonitor(row.group_id, {
        enabled: row.enabled,
        intervalMinutes: patch.intervalMinutes ?? row.interval_minutes,
        checkinRadiusMiles: patch.checkinRadiusMiles ?? row.checkin_radius_miles,
      });
      const saved = res?.setting;
      if (saved) {
        setGroups((cur) => cur.map((g) => (g.group_id === row.group_id ? { ...g, ...saved } : g)));
      }
      setMessage({ type: "success", text: "Settings saved." });
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setSavingGroupId(null);
    }
  };

  const handleBulk = async (nextEnabled) => {
    setBulkSaving(true);
    setMessage(null);
    try {
      const res = await api.updateAllLocationMonitors({
        enabled: nextEnabled,
        intervalMinutes: defaultInterval,
        checkinRadiusMiles: defaultRadius,
      });
      setGroups(Array.isArray(res?.groups) ? res.groups : []);
      if (nextEnabled) {
        const ok = res?.immediate?.success || 0;
        const failed = res?.immediate?.failed || 0;
        setMessage({
          type: failed > 0 ? "error" : "success",
          text: `Enabled monitoring for ${res?.updatedCount || 0} groups. First checks: ${ok} ok, ${failed} pending/failed.`,
        });
      } else {
        setMessage({ type: "success", text: "Disabled monitoring for all driver groups." });
      }
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setBulkSaving(false);
    }
  };

  const handleExpand = async (row) => {
    const next = expandedGroupId === row.group_id ? null : row.group_id;
    setExpandedGroupId(next);
    if (next && !checkinsByGroup[row.group_id]) {
      setCheckinsLoadingId(row.group_id);
      try {
        const data = await api.getLocationCheckins(row.group_id, 25);
        setCheckinsByGroup((cur) => ({ ...cur, [row.group_id]: data }));
      } catch (err) {
        setCheckinsByGroup((cur) => ({ ...cur, [row.group_id]: { error: err.message } }));
      } finally {
        setCheckinsLoadingId((cur) => (cur === row.group_id ? null : cur));
      }
    }
  };

  return (
    <div>
      <div className="page-header">
        <h2>📡 Location Monitor</h2>
        <p>
          Toggle live load tracking per driver. When on, the bot pulls the driver's current load from
          Datatruck, decides whether they're heading to the shipper or receiver, watches the ETA, and
          asks the driver to report their status (Checked In / Checked Out) once when they reach the
          stop — building an on-time history for every shipper and receiver.
        </p>
      </div>

      {message && <div className={`alert alert-${message.type}`}>{message.text}</div>}

      <div className="card" style={{ marginBottom: "16px" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "16px", alignItems: "flex-end" }}>
          <div className="form-group" style={{ marginBottom: 0, minWidth: "180px" }}>
            <label>Default check interval (minutes)</label>
            <input
              type="number"
              className="form-input"
              min={1}
              max={1440}
              value={defaultInterval}
              onChange={(e) => setDefaultInterval(Number(e.target.value))}
            />
          </div>
          <div className="form-group" style={{ marginBottom: 0, minWidth: "180px" }}>
            <label>Default check-in radius (miles)</label>
            <input
              type="number"
              className="form-input"
              min={1}
              max={100}
              value={defaultRadius}
              onChange={(e) => setDefaultRadius(Number(e.target.value))}
            />
          </div>
          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={fetchGroups} disabled={loading || bulkSaving}>
              {loading ? "Refreshing…" : "🔄 Refresh"}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => handleBulk(true)} disabled={bulkSaving}>
              {bulkSaving ? "Applying…" : "🟢 Enable All"}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => handleBulk(false)} disabled={bulkSaving}>
              🔴 Disable All
            </button>
          </div>
          <div style={{ marginLeft: "auto", color: "var(--text-secondary)", fontSize: "13px" }}>
            {enabledCount} of {groups.length} monitored
          </div>
        </div>
        <div style={{ marginTop: "12px" }}>
          <input
            type="text"
            className="form-input"
            placeholder="Search by driver, group, or unit…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {loading ? (
        <div className="loading" style={{ padding: "16px 0", justifyContent: "flex-start" }}>
          <div className="spinner"></div>
          Loading driver groups…
        </div>
      ) : (
        <div style={{ display: "grid", gap: "10px" }}>
          {displayGroups.length === 0 && (
            <div style={{ color: "var(--text-secondary)" }}>No active driver groups found.</div>
          )}

          {displayGroups.map((row) => {
            const saving = savingGroupId === row.group_id;
            const expanded = expandedGroupId === row.group_id;
            const pill = STATUS_PILL[row.last_status] || "neutral";
            const data = checkinsByGroup[row.group_id];
            return (
              <div
                key={row.group_id}
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: "12px",
                  padding: "12px 14px",
                  display: "grid",
                  gap: "8px",
                  background: "var(--bg-secondary)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
                  <div>
                    <div style={{ fontWeight: 600 }}>
                      {row.driver_name || row.group_name}
                      {row.unit_number ? <span style={{ color: "var(--text-secondary)", fontWeight: 400 }}> · Unit {row.unit_number}</span> : null}
                    </div>
                    <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>{row.group_name}</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => handleExpand(row)}>
                      {expanded ? "📋 Hide" : "📋 Details"}
                    </button>
                    <Toggle
                      on={row.enabled === true}
                      disabled={saving}
                      onClick={() => handleToggle(row, !row.enabled)}
                      label={`Toggle location monitoring for ${row.group_name}`}
                    />
                  </div>
                </div>

                <div style={{ display: "flex", gap: "14px", flexWrap: "wrap", color: "var(--text-secondary)", fontSize: "13px" }}>
                  <span>
                    Status:{" "}
                    <span className={`status-pill status-pill--${pill}`}>{row.last_status || "idle"}</span>
                  </span>
                  {row.enabled && row.load_phase && <span>Heading: {PHASE_LABEL[row.load_phase] || row.load_phase}</span>}
                  {row.enabled && row.last_distance_miles != null && (
                    <span>Distance: {Math.round(Number(row.last_distance_miles))} mi</span>
                  )}
                  {row.enabled && row.last_eta_minutes != null && <span>ETA: {formatEtaMinutes(row.last_eta_minutes)}</span>}
                  {row.enabled && <span>Next check: {formatDateTime(row.next_run_at, { future: true })}</span>}
                </div>

                {row.stats && row.stats.answered > 0 && (
                  <div style={{ display: "flex", gap: "14px", flexWrap: "wrap", fontSize: "13px", color: "var(--text-secondary)" }}>
                    <span>✅ Checked in: {row.stats.checked_in}</span>
                    <span>🚪 Checked out: {row.stats.checked_out}</span>
                    <span>⏱️ On time: {row.stats.on_time}</span>
                    <span>🐢 Late: {row.stats.late}</span>
                  </div>
                )}

                {row.last_error && (
                  <div style={{ color: "var(--danger)", fontSize: "13px" }}>Last error: {row.last_error}</div>
                )}

                {expanded && (
                  <div style={{ marginTop: "6px", paddingTop: "10px", borderTop: "1px solid var(--border)", display: "grid", gap: "10px" }}>
                    <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", alignItems: "flex-end" }}>
                      <div className="form-group" style={{ marginBottom: 0, minWidth: "160px" }}>
                        <label>Check interval (min)</label>
                        <input
                          type="number"
                          className="form-input"
                          min={1}
                          max={1440}
                          defaultValue={row.interval_minutes}
                          onBlur={(e) => {
                            const v = Number(e.target.value);
                            if (Number.isInteger(v) && v >= 1 && v <= 1440 && v !== row.interval_minutes) {
                              handleSaveConfig(row, { intervalMinutes: v });
                            }
                          }}
                        />
                      </div>
                      <div className="form-group" style={{ marginBottom: 0, minWidth: "160px" }}>
                        <label>Check-in radius (mi)</label>
                        <input
                          type="number"
                          className="form-input"
                          min={1}
                          max={100}
                          defaultValue={row.checkin_radius_miles}
                          onBlur={(e) => {
                            const v = Number(e.target.value);
                            if (Number.isFinite(v) && v >= 1 && v <= 100 && v !== row.checkin_radius_miles) {
                              handleSaveConfig(row, { checkinRadiusMiles: v });
                            }
                          }}
                        />
                      </div>
                    </div>

                    {row.target_address && (
                      <div style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
                        <strong style={{ color: "var(--text-primary)" }}>Current target ({row.target_stop_type || "stop"}):</strong>{" "}
                        {row.target_address}
                        {row.target_appointment_at ? ` · appt ${formatDateTime(row.target_appointment_at)}` : ""}
                      </div>
                    )}
                    {row.current_order_id && (
                      <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Datatruck order: {row.current_order_id}</div>
                    )}

                    <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>Recent check-ins</div>
                    {checkinsLoadingId === row.group_id ? (
                      <div className="loading" style={{ justifyContent: "flex-start" }}>
                        <div className="spinner"></div> Loading…
                      </div>
                    ) : data?.error ? (
                      <div style={{ color: "var(--danger)", fontSize: "13px" }}>{data.error}</div>
                    ) : Array.isArray(data?.checkins) && data.checkins.length > 0 ? (
                      <div style={{ overflowX: "auto" }}>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                          <thead>
                            <tr style={{ textAlign: "left", color: "var(--text-secondary)" }}>
                              <th style={{ padding: "4px 8px" }}>When</th>
                              <th style={{ padding: "4px 8px" }}>Stop</th>
                              <th style={{ padding: "4px 8px" }}>Answer</th>
                              <th style={{ padding: "4px 8px" }}>On time</th>
                              <th style={{ padding: "4px 8px" }}>By</th>
                            </tr>
                          </thead>
                          <tbody>
                            {data.checkins.map((c) => (
                              <tr key={c.id} style={{ borderTop: "1px solid var(--border)" }}>
                                <td style={{ padding: "4px 8px" }}>{formatDateTime(c.created_at)}</td>
                                <td style={{ padding: "4px 8px", textTransform: "capitalize" }}>{c.stop_type}</td>
                                <td style={{ padding: "4px 8px" }}>
                                  {(c.driver_response === "checked_in" || c.driver_response === "yes") ? "✅ Checked In" : (c.driver_response === "checked_out" || c.driver_response === "no") ? "🚪 Checked Out" : c.status === "expired" ? "⌛ Expired" : "… waiting"}
                                </td>
                                <td style={{ padding: "4px 8px" }}>
                                  {c.on_time === true ? "On time" : c.on_time === false ? "Late" : "—"}
                                </td>
                                <td style={{ padding: "4px 8px" }}>{c.responded_by_username ? `@${c.responded_by_username}` : "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div style={{ fontSize: "13px", color: "var(--text-secondary)", fontStyle: "italic" }}>
                        No check-ins recorded yet for this driver.
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
