import React, { useState, useEffect, useCallback, useMemo } from "react";
import * as api from "../api";

// Short local time label for a predicted boundary-arrival timestamp.
function formatEta(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function FuelMonitorPage() {
  const [drivers, setDrivers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState(null);
  const [sendingGroupId, setSendingGroupId] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");

  const fetchDrivers = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getFuelMonitor();
      setDrivers(Array.isArray(data) ? data : []);
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
          Active company drivers (from Driver Groups, the source of truth). The bot tags each
          driver using the Telegram member linked on the Driver Groups page — drivers without an
          @username are tagged via an inline mention — when their truck approaches a gas station
          posted in their group.
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
                <th>Next Gas Station</th>
                <th>Reminder</th>
              </tr>
            </thead>
            <tbody>
              {displayDrivers.map((driver) => {
                const sending = sendingGroupId === driver.group_id;
                const watching = Array.isArray(driver.watching) ? driver.watching : [];
                const nextStop = watching[0] || null;
                return (
                  <tr key={driver.group_id}>
                    <td>
                      {driver.display_name || driver.group_name || "—"}
                      {driver.telegram_username && (
                        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                          @{driver.telegram_username}
                        </div>
                      )}
                    </td>
                    <td>{driver.group_name || "—"}</td>
                    <td>{driver.unit_number || "—"}</td>
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
