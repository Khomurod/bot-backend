import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import * as api from "../api";
import { TelegramPreview, MediaUploader, MediaPositionSelector, useFormattingToolbar, getDaysUntilBirthday } from "../components/Shared";

export default function GroupsPage() {
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState(null);

  const fetchGroups = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getGroups();
      const sorted = data.sort((a, b) => getDaysUntilBirthday(a.driver_birthday) - getDaysUntilBirthday(b.driver_birthday));
      setGroups(sorted);
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let isMounted = true;
    const fetchData = async () => {
      setLoading(true);
      try {
        const data = await api.getGroups();
        const sorted = data.sort((a, b) => getDaysUntilBirthday(a.driver_birthday) - getDaysUntilBirthday(b.driver_birthday));
        if (isMounted) setGroups(sorted);
      } catch (err) {
        if (isMounted) setMessage({ type: 'error', text: err.message });
      } finally {
        if (isMounted) setLoading(false);
      }
    };
    fetchData();
    return () => { isMounted = false; };
  }, []);

  const handleLanguageChange = async (groupId, language) => {
    try {
      await api.setGroupLanguage(groupId, language);
      setMessage({ type: 'success', text: 'Language updated successfully!' });
      fetchGroups();
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    }
  };

  return (
    <div>
      <div className="page-header">
        <h2>👥 Driver Groups</h2>
        <p>Manage Telegram groups and driver languages</p>
      </div>

      {message && (
        <div className={`alert alert-${message.type}`}>
          {message.text}
        </div>
      )}

      {loading ? (
        <div className="loading"><div className="spinner"></div> Loading groups...</div>
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
              {groups.map(group => (
                <tr key={group.id}>
                  <td><strong>{group.group_name}</strong></td>
                  <td><code>{group.telegram_group_id}</code></td>
                  <td>{group.driver_first_name} {group.driver_last_name}</td>
                  <td>
                    {group.driver_birthday ? (
                      <span className={`badge ${getDaysUntilBirthday(group.driver_birthday) <= 7 ? 'badge-active' : ''}`}>
                        🎂 {new Date(group.driver_birthday).toLocaleDateString(undefined, { timeZone: 'UTC' })}
                        {getDaysUntilBirthday(group.driver_birthday) <= 7 && ` (in ${getDaysUntilBirthday(group.driver_birthday)}d)`}
                      </span>
                    ) : '-'}
                  </td>
                  <td>
                    <select
                      className="form-input"
                      style={{ width: 'auto', padding: '4px 8px' }}
                      value={group.language || ''}
                      onChange={(e) => handleLanguageChange(group.id, e.target.value)}
                    >
                      <option value="en">🇺🇸 English</option>
                      <option value="ru">🇷🇺 Russian</option>
                      <option value="uz">🇺🇿 Uzbek</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─────────────── Questions Page ───────────────
