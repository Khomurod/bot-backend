import React, { useState, useEffect, useCallback, useMemo } from "react";
import * as api from "../api";

function formatDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString();
}

const ACTION_LABEL = {
  "loccheck:in": "✅ Checked In",
  "loccheck:out": "🚪 Checked Out",
};

export default function UsersPage() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState(null);
  const [search, setSearch] = useState("");

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getBotUsers();
      setUsers(Array.isArray(data?.users) ? data.users : []);
      setMessage(null);
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => {
      const name = [u.first_name, u.last_name].filter(Boolean).join(" ");
      return (
        (u.username || "").toLowerCase().includes(q)
        || name.toLowerCase().includes(q)
        || String(u.telegram_user_id).includes(q)
        || (u.last_group_name || "").toLowerCase().includes(q)
      );
    });
  }, [users, search]);

  return (
    <div>
      <div className="page-header">
        <h2>👤 Users</h2>
        <p>
          Every Telegram user who has interacted with the bot's buttons (check-in prompts etc.),
          captured with their username and user ID on each tap.
        </p>
      </div>

      {message && (
        <div className={`alert alert-${message.type === "error" ? "danger" : "success"}`}>
          {message.text}
        </div>
      )}

      <div style={{ display: "flex", gap: "12px", alignItems: "center", marginBottom: "16px", flexWrap: "wrap" }}>
        <input
          type="text"
          placeholder="Search by name, @username, user ID or group…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ maxWidth: "340px" }}
        />
        <button className="btn btn-secondary" onClick={fetchUsers} disabled={loading}>
          🔄 Refresh
        </button>
        <span style={{ color: "var(--text-secondary)", fontSize: "13px" }}>
          {filtered.length} user{filtered.length === 1 ? "" : "s"}
        </span>
      </div>

      {loading ? (
        <div className="loading"><div className="spinner"></div> Loading…</div>
      ) : filtered.length === 0 ? (
        <div style={{ color: "var(--text-secondary)" }}>
          No button interactions recorded yet.
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--text-secondary)" }}>
                <th style={{ padding: "10px 12px" }}>User</th>
                <th style={{ padding: "10px 12px" }}>Username</th>
                <th style={{ padding: "10px 12px" }}>User ID</th>
                <th style={{ padding: "10px 12px" }}>Interactions</th>
                <th style={{ padding: "10px 12px" }}>Last action</th>
                <th style={{ padding: "10px 12px" }}>Last group</th>
                <th style={{ padding: "10px 12px" }}>Last active</th>
                <th style={{ padding: "10px 12px" }}>First seen</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((u) => {
                const name = [u.first_name, u.last_name].filter(Boolean).join(" ");
                return (
                  <tr key={u.telegram_user_id} style={{ borderTop: "1px solid var(--border)" }}>
                    <td style={{ padding: "8px 12px", fontWeight: 500 }}>{name || "—"}</td>
                    <td style={{ padding: "8px 12px" }}>{u.username ? `@${u.username}` : "—"}</td>
                    <td style={{ padding: "8px 12px", fontFamily: "monospace" }}>{u.telegram_user_id}</td>
                    <td style={{ padding: "8px 12px" }}>{u.interactions}</td>
                    <td style={{ padding: "8px 12px" }}>{ACTION_LABEL[u.last_action] || u.last_action || "—"}</td>
                    <td style={{ padding: "8px 12px" }}>{u.last_group_name || "—"}</td>
                    <td style={{ padding: "8px 12px" }}>{formatDateTime(u.last_interaction_at)}</td>
                    <td style={{ padding: "8px 12px" }}>{formatDateTime(u.first_seen_at)}</td>
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
