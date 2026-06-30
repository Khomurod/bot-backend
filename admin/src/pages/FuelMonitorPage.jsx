import React, { useState, useEffect, useCallback, useMemo } from "react";
import * as api from "../api";

// Strip a leading '@' and lowercase for display/compare; storage is handled
// server-side. Empty string clears the username.
function normalizeUsernameInput(value) {
  return String(value || "").trim().replace(/^@+/, "");
}

// Short local time label for a predicted boundary-arrival timestamp.
function formatEta(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function FuelMonitorPage() {
  const [drivers, setDrivers] = useState([]);
  const [draftsByGroup, setDraftsByGroup] = useState({});
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState(null);
  const [savingGroupId, setSavingGroupId] = useState(null);
  const [sendingGroupId, setSendingGroupId] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");

  const fetchDrivers = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getFuelMonitor();
      const list = Array.isArray(data) ? data : [];
      setDrivers(list);
      const nextDrafts = {};
      for (const d of list) {
        nextDrafts[d.group_id] = d.telegram_username || "";
      }
      setDraftsByGroup(nextDrafts);
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDrivers();
  }, [fetchDrivers]);

  const displayDrivers = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = [...drivers].sort((a, b) =>
      String(a.display_name || a.group_name || "").localeCompare(
        String(b.display_name || b.group_name || "")
      )
    );
    if (!q) return list;
    return list.filter((d) =>
      [d.display_name, d.group_name, d.unit_number, d.telegram_username]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q))
    );
  }, [drivers, search]);

  const saveUsername = async (driver) => {
    const draft = normalizeUsernameInput(draftsByGroup[driver.group_id]);
    const current = driver.telegram_username || "";
    if (draft === current) return; // no change
    setSavingGroupId(driver.group_id);
    setMessage(null);
    try {
      await api.updateFuelMonitorUsername(driver.group_id, draft);
      setMessage({
        type: "success",
        text: draft
          ? `Saved @${draft} for ${driver.display_name || driver.group_name}.`
          : `Cleared username for ${driver.display_name || driver.group_name}.`,
      });
      await fetchDrivers();
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setSavingGroupId(null);
    }
  };

  const sendReminder = async (driver) => {
    setSendingGroupId(driver.group_id);
    setMessage(null);
    try {
      await api.sendFuelReminder(driver.group_id);
      setMessage({
        type: "success",
        text: `Reminder sent to ${driver.display_name || driver.group_name}'s group.`,
      });
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setSendingGroupId(null);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    setMessage(null);
    try {
      const result = await api.refreshFuelMonitor();
      const picked = result.picked_up ?? 0;
      const scanned = result.scanned ?? 0;
      setMessage({
        type: "success",
        text: picked > 0
          ? `Picked up ${picked} new fuel stop${picked !== 1 ? "s" : ""} from ${scanned} recent message${scanned !== 1 ? "s" : ""}.`
          : `Scanned ${scanned} recent message${scanned !== 1 ? "s" : ""} — no new fuel stops found.`,
      });
      await fetchDrivers();
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setRefreshing(false);
    }
  };

  const watchingCount = useMemo(
    () => drivers.reduce((sum, d) => sum + (Array.isArray(d.watching) ? d.watching.length : 0), 0),
    [drivers]
  );

  return (
    <div>
      <div className="page-header">
        <h2>⛽ Fuel Monitor</h2>
        <p>
          Active company drivers (from Driver Groups, the source of truth). Set each driver's
          Telegram username so the bot can tag them when their truck comes within 10 miles of a
          gas station posted in their group.
        </p>
      </div>

      {message && (
        <div className={`alert alert-${message.type}`}>{message.text}</div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="text"
            placeholder="Search driver, group, or unit…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ maxWidth: 320 }}
          />
          <button
            type="button"
            className="btn btn-secondary"
            disabled={refreshing}
            title="Re-scan recently seen fuel messages and pick up any that were missed"
            onClick={handleRefresh}
          >
            {refreshing ? "Refreshing…" : "⟳ Refresh"}
          </button>
        </div>
        <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
          {drivers.length} active company drivers · {watchingCount} fuel stop(s) being watched
        </span>
      </div>

      {loading ? (
        <div className="loading"><div className="spinner"></div> Loading drivers...</div>
      ) : displayDrivers.length === 0 ? (
        <div className="empty-state">
          <div className="icon">⛽</div>
          <h3>No active company drivers</h3>
          <p>Mark drivers as active company drivers in the Driver Groups section first.</p>
        </div>
      ) : (
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>Driver</th>
                <th>Group Name</th>
                <th>Unit</th>
                <th>Telegram Username</th>
                <th>Next Gas Station</th>
                <th>Reminder</th>
              </tr>
            </thead>
            <tbody>
              {displayDrivers.map((driver) => {
                const saving = savingGroupId === driver.group_id;
                const sending = sendingGroupId === driver.group_id;
                const watching = Array.isArray(driver.watching) ? driver.watching : [];
                const nextStop = watching[0] || null;
                return (
                  <tr key={driver.group_id}>
                    <td>{driver.display_name || driver.group_name || "—"}</td>
                    <td>{driver.group_name || "—"}</td>
                    <td>{driver.unit_number || "—"}</td>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ color: "var(--text-muted)" }}>@</span>
                        <input
                          type="text"
                          value={draftsByGroup[driver.group_id] ?? ""}
                          placeholder="username"
                          disabled={saving}
                          onChange={(e) =>
                            setDraftsByGroup((prev) => ({
                              ...prev,
                              [driver.group_id]: normalizeUsernameInput(e.target.value),
                            }))
                          }
                          onBlur={() => saveUsername(driver)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") e.currentTarget.blur();
                          }}
                          style={{ maxWidth: 200 }}
                        />
                        {saving && <span className="spinner" style={{ width: 14, height: 14 }} />}
                      </div>
                    </td>
                    <td>
                      {!nextStop ? (
                        <span style={{ color: "var(--text-muted)" }}>— none picked up —</span>
                      ) : (
                        <div style={{ fontSize: 12 }}>
                          <div style={{ fontWeight: 600 }}>
                            {nextStop.station_name || "Fuel stop"}
                          </div>
                          {nextStop.station_address && (
                            <div style={{ color: "var(--text-muted)" }}>{nextStop.station_address}</div>
                          )}
                          <div style={{ color: "var(--text-muted)" }}>
                            {Number.isFinite(Number(nextStop.last_distance_miles))
                              ? `~${Math.round(Number(nextStop.last_distance_miles))} mi away`
                              : "locating truck…"}
                            {nextStop.eta_boundary_at
                              ? ` · ETA ~${formatEta(nextStop.eta_boundary_at)}`
                              : ""}
                          </div>
                        </div>
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={!nextStop || sending}
                        title={nextStop ? "Send the fuel reminder to this group now" : "No active fuel stop to remind about"}
                        onClick={() => sendReminder(driver)}
                      >
                        {sending ? "Sending…" : "Send reminder"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
