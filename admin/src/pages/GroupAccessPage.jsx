import React, { useEffect, useState } from "react";
import * as api from "../api";

function timeAgo(iso) {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

const LEVEL_STYLE = {
  ok: { color: "#16a34a", dot: "🟢" },
  warn: { color: "#d97706", dot: "🟡" },
  bad: { color: "#dc2626", dot: "🔴" },
  unknown: { color: "#9ca3af", dot: "⚪" },
};

function roleLabel(status) {
  switch (status) {
    case "administrator":
    case "creator":
      return "Admin";
    case "member":
      return "Member";
    case "restricted":
      return "Restricted";
    case "left":
    case "kicked":
    case "not_found":
      return "Not in group";
    case "error":
      return "Check failed";
    default:
      return "Unknown";
  }
}

export default function GroupAccessPage() {
  const [groups, setGroups] = useState([]);
  const [summary, setSummary] = useState({});
  const [lastChecked, setLastChecked] = useState(null);
  const [loading, setLoading] = useState(true);
  const [rechecking, setRechecking] = useState(false);
  const [status, setStatus] = useState(null);

  const load = async () => {
    try {
      const res = await api.getGroupAccess();
      setGroups(res.groups || []);
      setSummary(res.summary || {});
      setLastChecked(res.lastChecked || null);
    } catch (err) {
      setStatus({ type: "error", text: err.message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const recheck = async () => {
    setRechecking(true);
    setStatus(null);
    try {
      const res = await api.recheckGroupAccess();
      setGroups(res.groups || []);
      const s = (res.groups || []).reduce((acc, g) => {
        acc[g.reading_level] = (acc[g.reading_level] || 0) + 1;
        return acc;
      }, {});
      setSummary(s);
      setLastChecked(res.checkedAt || null);
      setStatus({
        type: "success",
        text: `Checked ${res.checked} groups: ${res.reachable} reachable, ${res.notInGroup} not in group${res.errors ? `, ${res.errors} errors` : ""}.`,
      });
    } catch (err) {
      setStatus({ type: "error", text: err.message });
    } finally {
      setRechecking(false);
    }
  };

  if (loading) {
    return <div className="loading"><div className="spinner"></div> Loading...</div>;
  }

  return (
    <div>
      <div className="page-header">
        <h2>🔍 Bot Group Access</h2>
        <p>Shows which driver groups the bot can actually read. If the bot can't read a group, it can't track home time, loads, or anything else there.</p>
      </div>

      {status && (
        <div className={`alert alert-${status.type}`} style={{ marginBottom: 16 }}>{status.text}</div>
      )}

      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
          <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
            <div>🟢 <strong>{summary.ok || 0}</strong> reading</div>
            <div>🟡 <strong>{summary.warn || 0}</strong> maybe blocked</div>
            <div>🔴 <strong>{summary.bad || 0}</strong> not in group</div>
            <div>⚪ <strong>{summary.unknown || 0}</strong> not checked</div>
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <span style={{ color: "#888" }}>Roles checked: {timeAgo(lastChecked)}</span>
            <button className="btn btn-primary" onClick={recheck} disabled={rechecking}>
              {rechecking ? "Checking…" : "Recheck access"}
            </button>
          </div>
        </div>
        <p style={{ color: "#888", marginBottom: 0, marginTop: 12 }}>
          "Reading" is proven two ways: the bot is an <strong>admin</strong> (reads everything), or it has
          actually <strong>received messages</strong> recently. A group marked 🟡 means the bot is only a plain
          member and no messages have arrived — usually fixed by making the bot an admin in that group.
        </p>
      </div>

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Driver / Group</th>
              <th>Unit</th>
              <th>Bot role</th>
              <th>Reading messages?</th>
              <th>Last message seen</th>
              <th>Home state</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const style = LEVEL_STYLE[g.reading_level] || LEVEL_STYLE.unknown;
              return (
                <tr key={g.group_id} style={g.reading_level === "bad" ? { background: "rgba(220,38,38,0.08)" } : g.reading_level === "warn" ? { background: "rgba(217,119,6,0.08)" } : undefined}>
                  <td>
                    {g.driver_name}
                    {!g.active && <span style={{ color: "#9ca3af" }}> (inactive)</span>}
                  </td>
                  <td>{g.unit_number || "—"}</td>
                  <td>{roleLabel(g.bot_member_status)}</td>
                  <td style={{ color: style.color }}>
                    {style.dot} {g.reading_label}
                  </td>
                  <td>{timeAgo(g.last_message_seen_at)}</td>
                  <td>{g.home_state === "road" ? "🚚 On the road" : g.home_state === "home" ? "🏠 Home" : "—"}</td>
                </tr>
              );
            })}
            {groups.length === 0 && (
              <tr><td colSpan={6} style={{ textAlign: "center", color: "#888" }}>No driver groups found.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
