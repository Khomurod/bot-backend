import React, { useEffect, useMemo, useState } from "react";
import { getBotUsers } from "../api";
import {
  getAutoReactions,
  createAutoReaction,
  updateAutoReaction,
  deleteAutoReaction,
} from "../autoReactionsApi";

function userLabel(u) {
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
  const handle = u.username ? `@${u.username}` : "";
  return [name || "(no name)", handle].filter(Boolean).join(" · ") + ` — ${u.telegram_user_id}`;
}

function ruleTarget(rule) {
  if (rule.telegram_username) return `@${rule.telegram_username}`;
  return `ID ${rule.telegram_user_id}`;
}

export default function AutoReactionsPage() {
  const [rules, setRules] = useState([]);
  const [allowedEmojis, setAllowedEmojis] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  // Draft form state.
  const [mode, setMode] = useState("list"); // 'list' = pick a seen user, 'manual' = type a username
  const [selectedUserId, setSelectedUserId] = useState("");
  const [manualUsername, setManualUsername] = useState("");
  const [emoji, setEmoji] = useState("");
  const [userSearch, setUserSearch] = useState("");

  const flash = (type, text) => setMessage({ type, text });

  const load = async () => {
    setLoading(true);
    try {
      const [rulesRes, usersRes] = await Promise.all([
        getAutoReactions(),
        getBotUsers({ limit: 500 }).catch(() => ({ users: [] })),
      ]);
      setRules(rulesRes.rules || []);
      setAllowedEmojis(rulesRes.allowed_emojis || []);
      setUsers(Array.isArray(usersRes?.users) ? usersRes.users : []);
      if (!emoji && (rulesRes.allowed_emojis || []).length) {
        setEmoji(rulesRes.allowed_emojis[0]);
      }
      setMessage(null);
    } catch (err) {
      flash("error", err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filteredUsers = useMemo(() => {
    const q = userSearch.trim().toLowerCase();
    const base = users;
    if (!q) return base.slice(0, 200);
    return base
      .filter((u) => {
        const name = [u.first_name, u.last_name].filter(Boolean).join(" ").toLowerCase();
        return (
          (u.username || "").toLowerCase().includes(q)
          || name.includes(q)
          || String(u.telegram_user_id).includes(q)
        );
      })
      .slice(0, 200);
  }, [users, userSearch]);

  const addRule = async (e) => {
    e.preventDefault();
    if (!emoji) return flash("error", "Pick a reaction emoji.");
    const payload = { emoji };
    if (mode === "list") {
      if (!selectedUserId) return flash("error", "Select a user from the list.");
      payload.telegram_user_id = selectedUserId;
      const picked = users.find((u) => String(u.telegram_user_id) === String(selectedUserId));
      if (picked?.username) payload.telegram_username = picked.username;
    } else {
      const uname = manualUsername.trim();
      if (!uname) return flash("error", "Enter a Telegram username.");
      payload.telegram_username = uname;
    }
    setSaving(true);
    setMessage(null);
    try {
      await createAutoReaction(payload);
      flash("success", "Reaction rule saved. The bot will react to that user's messages.");
      setSelectedUserId("");
      setManualUsername("");
      await load();
    } catch (err) {
      flash("error", err.message);
    } finally {
      setSaving(false);
    }
  };

  const toggleRule = async (rule) => {
    setMessage(null);
    try {
      await updateAutoReaction(rule.id, { enabled: !rule.enabled });
      await load();
    } catch (err) {
      flash("error", err.message);
    }
  };

  const changeEmoji = async (rule, nextEmoji) => {
    if (nextEmoji === rule.emoji) return;
    setMessage(null);
    try {
      await updateAutoReaction(rule.id, { emoji: nextEmoji });
      await load();
    } catch (err) {
      flash("error", err.message);
    }
  };

  const removeRule = async (rule) => {
    if (!window.confirm(`Stop reacting to ${ruleTarget(rule)}?`)) return;
    setMessage(null);
    try {
      await deleteAutoReaction(rule.id);
      flash("success", "Reaction rule removed.");
      await load();
    } catch (err) {
      flash("error", err.message);
    }
  };

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner"></div> Loading…
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <h2>😀 Auto Reactions</h2>
        <p>
          Pick a user — from the list of people the bot has seen, or by typing a Telegram username —
          and a reaction. The bot then automatically adds that reaction to every message that user
          posts in any group it is in.
        </p>
      </div>

      {message && (
        <div className={`alert alert-${message.type === "error" ? "danger" : "success"}`} style={{ marginBottom: 16 }}>
          {message.text}
        </div>
      )}

      <div className="card" style={{ marginBottom: 20 }}>
        <h3>Add a reaction rule</h3>
        <form onSubmit={addRule}>
          <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
            <button
              type="button"
              className={`btn btn-sm ${mode === "list" ? "btn-primary" : "btn-ghost"}`}
              onClick={() => setMode("list")}
            >
              Select from users
            </button>
            <button
              type="button"
              className={`btn btn-sm ${mode === "manual" ? "btn-primary" : "btn-ghost"}`}
              onClick={() => setMode("manual")}
            >
              Enter username
            </button>
          </div>

          {mode === "list" ? (
            <div className="form-group">
              <label>User</label>
              <input
                className="form-input"
                type="text"
                placeholder="Search users by name, @username or ID…"
                value={userSearch}
                onChange={(e) => setUserSearch(e.target.value)}
                style={{ marginBottom: 8 }}
              />
              <select
                className="form-select"
                value={selectedUserId}
                onChange={(e) => setSelectedUserId(e.target.value)}
              >
                <option value="">— choose a user —</option>
                {filteredUsers.map((u) => (
                  <option key={u.telegram_user_id} value={u.telegram_user_id}>
                    {userLabel(u)}
                  </option>
                ))}
              </select>
              {users.length === 0 && (
                <p className="home-time-muted" style={{ margin: "6px 0 0" }}>
                  No seen users yet — switch to “Enter username”.
                </p>
              )}
            </div>
          ) : (
            <div className="form-group">
              <label>Telegram username</label>
              <input
                className="form-input"
                type="text"
                placeholder="@username"
                value={manualUsername}
                onChange={(e) => setManualUsername(e.target.value)}
              />
            </div>
          )}

          <div className="form-group">
            <label>Reaction</label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, maxWidth: 640 }}>
              {allowedEmojis.map((em) => (
                <button
                  type="button"
                  key={em}
                  className={`btn btn-sm ${emoji === em ? "btn-primary" : "btn-ghost"}`}
                  onClick={() => setEmoji(em)}
                  style={{ fontSize: 18, lineHeight: 1, padding: "6px 8px" }}
                  aria-label={`React with ${em}`}
                >
                  {em}
                </button>
              ))}
            </div>
          </div>

          <button className="btn btn-primary" type="submit" disabled={saving}>
            {saving ? "Saving…" : "Add reaction rule"}
          </button>
        </form>
      </div>

      <div className="card">
        <h3>Active rules</h3>
        {rules.length === 0 ? (
          <p className="home-time-muted" style={{ margin: 0 }}>No reaction rules yet.</p>
        ) : (
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>Target</th>
                  <th>Reaction</th>
                  <th>Enabled</th>
                  <th>Added</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rules.map((rule) => (
                  <tr key={rule.id} style={{ opacity: rule.enabled ? 1 : 0.55 }}>
                    <td>{ruleTarget(rule)}</td>
                    <td>
                      <select
                        className="form-select"
                        value={rule.emoji}
                        onChange={(e) => changeEmoji(rule, e.target.value)}
                        style={{ width: 80, fontSize: 18 }}
                      >
                        {allowedEmojis.map((em) => (
                          <option key={em} value={em}>{em}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <button
                        className={`btn btn-sm ${rule.enabled ? "btn-primary" : "btn-ghost"}`}
                        type="button"
                        onClick={() => toggleRule(rule)}
                      >
                        {rule.enabled ? "On" : "Off"}
                      </button>
                    </td>
                    <td>{rule.created_at ? new Date(rule.created_at).toLocaleDateString() : "—"}</td>
                    <td>
                      <button className="btn btn-sm btn-danger" type="button" onClick={() => removeRule(rule)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
