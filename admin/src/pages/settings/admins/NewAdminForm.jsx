import React from "react";

import * as api from "../../../api";

export const MIN_PASSWORD = 10;

/**
 * Create one admin account: a username, a password typed twice, and at least
 * one role. The same rules the server enforces (`adminUserRoutes.js`) are
 * checked here first so a person is told before the request, not after.
 */
export default function NewAdminForm({ roles, onCreated, flash }) {
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [roleIds, setRoleIds] = React.useState([]);
  const [saving, setSaving] = React.useState(false);

  const assignable = roles.filter((r) => r.active !== false);
  const problem = !username.trim() ? "Enter a username."
    : password.length < MIN_PASSWORD ? `The password needs at least ${MIN_PASSWORD} characters.`
      : password !== confirm ? "The two passwords do not match."
        : roleIds.length === 0 ? "Choose at least one role."
          : null;

  const toggleRole = (id) => setRoleIds((prev) => (
    prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
  ));

  const submit = async (e) => {
    e.preventDefault();
    if (problem) return;
    setSaving(true);
    try {
      const user = await api.createAdminUser({ username: username.trim(), password, roleIds });
      flash("success", `${user?.username || username.trim()} can now sign in.`);
      setUsername(""); setPassword(""); setConfirm(""); setRoleIds([]);
      onCreated();
    } catch (err) {
      flash("error", err?.message || "Could not create the account.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="card" onSubmit={submit} aria-label="New admin account" style={{ marginTop: 16 }}>
      <h3 style={{ marginTop: 0 }}>Add an admin account</h3>
      <div className="home-time-form-grid">
        <div className="form-group">
          <label htmlFor="new-admin-username">Username</label>
          <input
            id="new-admin-username" className="form-input" autoComplete="off"
            value={username} onChange={(e) => setUsername(e.target.value)}
          />
        </div>
        <div className="form-group">
          <label htmlFor="new-admin-password">Password</label>
          <input
            id="new-admin-password" className="form-input" type="password" autoComplete="new-password"
            value={password} onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <div className="form-group">
          <label htmlFor="new-admin-confirm">Password again</label>
          <input
            id="new-admin-confirm" className="form-input" type="password" autoComplete="new-password"
            value={confirm} onChange={(e) => setConfirm(e.target.value)}
          />
        </div>
      </div>
      <fieldset style={{ border: 0, padding: 0, margin: "4px 0 8px" }}>
        <legend style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Roles</legend>
        {assignable.length === 0 && (
          <div style={{ color: "var(--text-muted)", fontSize: 12 }}>No roles can be assigned.</div>
        )}
        {assignable.map((role) => (
          <label key={role.id} style={{ display: "flex", gap: 6, alignItems: "flex-start", fontSize: 13, marginBottom: 4 }}>
            <input type="checkbox" checked={roleIds.includes(role.id)} onChange={() => toggleRole(role.id)} />
            <span>
              <strong>{role.display_name}</strong>
              {role.description && <span style={{ color: "var(--text-muted)" }}> — {role.description}</span>}
            </span>
          </label>
        ))}
      </fieldset>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button type="submit" className="btn btn-primary btn-sm" disabled={saving || Boolean(problem)}>
          {saving ? "Creating…" : "Create account"}
        </button>
        {problem && (username || password || confirm) && (
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{problem}</span>
        )}
      </div>
    </form>
  );
}
