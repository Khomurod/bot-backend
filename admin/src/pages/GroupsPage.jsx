import React, { useState, useEffect, useCallback, useMemo } from "react";
import * as api from "../api";
import {
  getDaysUntilBirthday,
  sortBySoonestBirthday,
  parseDriverNameFromGroupTitle,
} from "../components/Shared";

function formatBirthdayValue(driverBirthday) {
  if (!driverBirthday) return "";
  return String(driverBirthday).split("T")[0];
}

function displayDriverName(group) {
  const fromDb = [group.driver_first_name, group.driver_last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  if (fromDb) return fromDb;
  return parseDriverNameFromGroupTitle(group.group_name) || "—";
}

function isGroupActive(group) {
  return group.active !== false;
}

function formatStatusSource(source) {
  if (source === "manual") return "Manual";
  if (source === "ai") return "AI";
  if (source === "bot") return "Bot";
  return "—";
}

function prepareDisplayGroups(allGroups, activeTab, statusSort) {
  let list = sortBySoonestBirthday(allGroups, (g) => g.driver_birthday);

  if (activeTab === "active") {
    list = list.filter((g) => isGroupActive(g));
  } else if (activeTab === "inactive") {
    list = list.filter((g) => !isGroupActive(g));
  } else if (statusSort) {
    list = [...list].sort((a, b) => {
      const aRank = isGroupActive(a) ? 0 : 1;
      const bRank = isGroupActive(b) ? 0 : 1;
      const statusCmp = statusSort === "active-first" ? aRank - bRank : bRank - aRank;
      if (statusCmp !== 0) return statusCmp;
      return (
        getDaysUntilBirthday(a.driver_birthday) - getDaysUntilBirthday(b.driver_birthday)
      );
    });
  }

  return list;
}

export default function GroupsPage() {
  const [allGroups, setAllGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState(null);
  const [savingBirthdayId, setSavingBirthdayId] = useState(null);
  const [savingStatusId, setSavingStatusId] = useState(null);
  const [runningAi, setRunningAi] = useState(false);
  const [activeTab, setActiveTab] = useState("all");
  const [statusSort, setStatusSort] = useState("active-first");

  const fetchGroups = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getGroupsManage();
      setAllGroups(Array.isArray(data) ? data : []);
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchGroups();
  }, [fetchGroups]);

  const displayGroups = useMemo(
    () => prepareDisplayGroups(allGroups, activeTab, activeTab === "all" ? statusSort : null),
    [allGroups, activeTab, statusSort],
  );

  const handleLanguageChange = async (groupId, language) => {
    try {
      await api.setGroupLanguage(groupId, language);
      setMessage({ type: "success", text: "Language updated successfully!" });
      fetchGroups();
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    }
  };

  const handleBirthdayChange = async (groupId, birthday) => {
    setSavingBirthdayId(groupId);
    setMessage(null);
    try {
      await api.setGroupBirthday(groupId, birthday || null);
      setMessage({ type: "success", text: "Birthday updated successfully!" });
      await fetchGroups();
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setSavingBirthdayId(null);
    }
  };

  const toggleStatusSort = () => {
    setStatusSort((s) => (s === "active-first" ? "inactive-first" : "active-first"));
  };

  const handleStatusChange = async (groupId, active) => {
    setSavingStatusId(groupId);
    setMessage(null);
    try {
      await api.setGroupStatus(groupId, active);
      setMessage({
        type: "success",
        text: `Status set to ${active ? "Active" : "Inactive"} (manual — AI will not change this until you update it).`,
      });
      await fetchGroups();
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setSavingStatusId(null);
    }
  };

  const handleRunAiClassification = async () => {
    setRunningAi(true);
    setMessage(null);
    try {
      const result = await api.runGroupStatusAi();
      setMessage({
        type: "success",
        text: `AI classification finished: ${result.updated ?? 0} of ${result.total ?? 0} groups updated.`,
      });
      await fetchGroups();
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setRunningAi(false);
    }
  };

  const tabCounts = useMemo(() => ({
    all: allGroups.length,
    active: allGroups.filter((g) => isGroupActive(g)).length,
    inactive: allGroups.filter((g) => !isGroupActive(g)).length,
  }), [allGroups]);

  return (
    <div>
      <div className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h2>👥 Driver Groups</h2>
          <p>Manage groups, birthdays, and operational status. AI runs twice daily; manual status is locked from AI.</p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleRunAiClassification}
          disabled={runningAi || loading}
        >
          {runningAi ? "⏳ Classifying..." : "🤖 Run AI classification now"}
        </button>
      </div>

      {message && (
        <div className={`alert alert-${message.type}`}>
          {message.text}
        </div>
      )}

      <div className="broadcast-tabs" style={{ marginBottom: 16 }}>
        <button
          type="button"
          className={`broadcast-tab-btn ${activeTab === "all" ? "active" : ""}`}
          onClick={() => setActiveTab("all")}
        >
          All ({tabCounts.all})
        </button>
        <button
          type="button"
          className={`broadcast-tab-btn ${activeTab === "active" ? "active" : ""}`}
          onClick={() => setActiveTab("active")}
        >
          Active Drivers ({tabCounts.active})
        </button>
        <button
          type="button"
          className={`broadcast-tab-btn ${activeTab === "inactive" ? "active" : ""}`}
          onClick={() => setActiveTab("inactive")}
        >
          Inactive Drivers ({tabCounts.inactive})
        </button>
      </div>

      {loading ? (
        <div className="loading"><div className="spinner"></div> Loading groups...</div>
      ) : displayGroups.length === 0 ? (
        <div className="empty-state">
          <div className="icon">👥</div>
          <h3>No driver groups in this view</h3>
          <p>
            {activeTab === "inactive"
              ? "Inactive groups appear when the bot has left a driver Telegram group."
              : "Driver Telegram groups appear here once the bot has joined them."}
          </p>
        </div>
      ) : (
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>Group Name</th>
                <th>Telegram ID</th>
                <th>Driver Name</th>
                <th>
                  {activeTab === "all" ? (
                    <button
                      type="button"
                      onClick={toggleStatusSort}
                      style={{
                        background: "none",
                        border: "none",
                        padding: 0,
                        font: "inherit",
                        fontWeight: 600,
                        cursor: "pointer",
                        color: "inherit",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                      }}
                      title="Click to sort by status"
                    >
                      Status
                      <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                        {statusSort === "active-first" ? "▲ Active first" : "▲ Inactive first"}
                      </span>
                    </button>
                  ) : (
                    "Status"
                  )}
                </th>
                <th>Birthday</th>
                <th>Language</th>
              </tr>
            </thead>
            <tbody>
              {displayGroups.map((group) => {
                const bdayStr = formatBirthdayValue(group.driver_birthday);
                const daysUntil = group.driver_birthday
                  ? getDaysUntilBirthday(group.driver_birthday)
                  : null;
                const saving = savingBirthdayId === group.id;
                const savingStatus = savingStatusId === group.id;
                const active = isGroupActive(group);

                return (
                  <tr key={group.id}>
                    <td><strong>{group.group_name}</strong></td>
                    <td><code>{group.telegram_group_id}</code></td>
                    <td>{displayDriverName(group)}</td>
                    <td>
                      <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 140 }}>
                        <select
                          className="form-input"
                          style={{ width: "auto", padding: "4px 8px" }}
                          value={active ? "active" : "inactive"}
                          disabled={savingStatus}
                          onChange={(e) => handleStatusChange(group.id, e.target.value === "active")}
                        >
                          <option value="active">Active</option>
                          <option value="inactive">Inactive</option>
                        </select>
                        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                          via {formatStatusSource(group.status_source)}
                          {group.status_source === "manual" ? " (locked)" : ""}
                        </span>
                      </div>
                    </td>
                    <td>
                      <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 160 }}>
                        <input
                          type="date"
                          className="form-input"
                          style={{ padding: "4px 8px" }}
                          value={bdayStr}
                          disabled={saving}
                          onChange={(e) => handleBirthdayChange(group.id, e.target.value)}
                        />
                        {group.driver_birthday && daysUntil !== null && daysUntil <= 7 && (
                          <span className="badge badge-active" style={{ alignSelf: "flex-start" }}>
                            in {daysUntil}d
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      <select
                        className="form-input"
                        style={{ width: "auto", padding: "4px 8px" }}
                        value={group.language || ""}
                        onChange={(e) => handleLanguageChange(group.id, e.target.value)}
                      >
                        <option value="en">🇺🇸 English</option>
                        <option value="ru">🇷🇺 Russian</option>
                        <option value="uz">🇺🇿 Uzbek</option>
                      </select>
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
