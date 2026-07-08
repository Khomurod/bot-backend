import React, { useState, useEffect, useCallback, useMemo } from "react";
import * as api from "../api";

function formatDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString();
}

const SOURCE_LABEL = {
  dispatcher: "🎧 Dispatcher",
  driver: "🚚 Driver",
  admin: "🛠️ Admin",
  unknown: "❓ Unknown",
};

const FILTERS = [
  { key: "all", label: "All" },
  { key: "admins", label: "Admins" },
  { key: "dispatch", label: "Dispatch team" },
  { key: "drivers", label: "Drivers" },
  { key: "unknown", label: "Unknown" },
  { key: "recent", label: "Recently seen" },
];

export default function UsersPage() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getBotUsers({ filter });
      setUsers(Array.isArray(data?.users) ? data.users : []);
      setMessage(null);
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setLoading(false);
    }
  }, [filter]);

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
        || (u.linked_team_name || "").toLowerCase().includes(q)
      );
    });
  }, [users, search]);

  return (
    <div>
      <div className="page-header">
        <h2>👤 Users</h2>
        <p>
          Everyone the bot has seen: anyone who texts in a group the bot is in, plus users who tap
          the bot's inline buttons. Keyed by a stable Telegram user ID and linked to a dispatch team
          when their username or ID matches one. No message text is stored.
        </p>
      </div>

      {message && (
        <div className={`alert alert-${message.type === "error" ? "danger" : "success"}`}>
          {message.text}
        </div>
      )}

      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "12px" }}>
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={`btn btn-sm ${filter === f.key ? "btn-primary" : "btn-ghost"}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div style={{ display: "flex", gap: "12px", alignItems: "center", marginBottom: "16px", flexWrap: "wrap" }}>
        <input
          type="text"
          placeholder="Search by name, @username, user ID, group or team…"
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
          No users recorded yet for this filter.
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--text-secondary)" }}>
                <th style={{ padding: "10px 12px" }}>Display name</th>
                <th style={{ padding: "10px 12px" }}>Username</th>
                <th style={{ padding: "10px 12px" }}>Telegram ID</th>
                <th style={{ padding: "10px 12px" }}>Last seen group</th>
                <th style={{ padding: "10px 12px" }}>Last seen</th>
                <th style={{ padding: "10px 12px" }}>Messages</th>
                <th style={{ padding: "10px 12px" }}>Dispatch team</th>
                <th style={{ padding: "10px 12px" }}>Source</th>
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
                    <td style={{ padding: "8px 12px" }}>{u.last_group_name || "—"}</td>
                    <td style={{ padding: "8px 12px" }}>{formatDateTime(u.last_interaction_at)}</td>
                    <td style={{ padding: "8px 12px" }}>{u.message_count ?? 0}</td>
                    <td style={{ padding: "8px 12px" }}>{u.linked_team_name || "—"}</td>
                    <td style={{ padding: "8px 12px" }}>{SOURCE_LABEL[u.source] || u.source || "—"}</td>
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
