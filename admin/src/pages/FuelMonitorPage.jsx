import React, { useState, useEffect, useCallback, useMemo } from "react";
import * as api from "../api";

// Strip a leading '@' and lowercase for display/compare; storage is handled
// server-side. Empty string clears the username.
function normalizeUsernameInput(value) {
  return String(value || "").trim().replace(/^@+/, "");
}

export default function FuelMonitorPage() {
  const [drivers, setDrivers] = useState([]);
  const [draftsByGroup, setDraftsByGroup] = useState({});
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState(null);
  const [savingGroupId, setSavingGroupId] = useState(null);
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
        <input
          type="text"
          placeholder="Search driver, group, or unit…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ maxWidth: 320 }}
        />
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
                <th>Watching</th>
              </tr>
            </thead>
            <tbody>
              {displayDrivers.map((driver) => {
                const saving = savingGroupId === driver.group_id;
                const watching = Array.isArray(driver.watching) ? driver.watching : [];
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
                      {watching.length === 0 ? (
                        <span style={{ color: "var(--text-muted)" }}>—</span>
                      ) : (
                        watching.map((w) => (
                          <div key={w.id} style={{ fontSize: 12 }}>
                            {w.station_name || w.station_address || "Fuel stop"}
                            {Number.isFinite(Number(w.last_distance_miles))
                              ? ` · ${Math.round(Number(w.last_distance_miles))} mi away`
                              : ""}
                          </div>
                        ))
                      )}
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
