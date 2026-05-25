import React, { useState, useEffect, useCallback } from "react";
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

export default function GroupsPage() {
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState(null);
  const [savingBirthdayId, setSavingBirthdayId] = useState(null);

  const fetchGroups = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getGroups();
      setGroups(sortBySoonestBirthday(data, (g) => g.driver_birthday));
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchGroups();
  }, [fetchGroups]);

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

  return (
    <div>
      <div className="page-header">
        <h2>👥 Driver Groups</h2>
        <p>Manage Telegram groups, driver birthdays (soonest first), and languages</p>
      </div>

      {message && (
        <div className={`alert alert-${message.type}`}>
          {message.text}
        </div>
      )}

      {loading ? (
        <div className="loading"><div className="spinner"></div> Loading groups...</div>
      ) : groups.length === 0 ? (
        <div className="empty-state">
          <div className="icon">👥</div>
          <h3>No driver groups found</h3>
          <p>Active driver Telegram groups appear here once the bot has joined them.</p>
        </div>
      ) : (
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>Group Name</th>
                <th>Telegram ID</th>
                <th>Driver Name</th>
                <th>Birthday</th>
                <th>Language</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => {
                const bdayStr = formatBirthdayValue(group.driver_birthday);
                const daysUntil = group.driver_birthday
                  ? getDaysUntilBirthday(group.driver_birthday)
                  : null;
                const saving = savingBirthdayId === group.id;

                return (
                  <tr key={group.id}>
                    <td><strong>{group.group_name}</strong></td>
                    <td><code>{group.telegram_group_id}</code></td>
                    <td>{displayDriverName(group)}</td>
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
