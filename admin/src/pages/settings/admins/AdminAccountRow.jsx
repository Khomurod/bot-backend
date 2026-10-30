import React from "react";

import * as api from "../../../api";
import { timeAgo } from "../../../utils/formatTime";
import { MIN_PASSWORD } from "./NewAdminForm";

/**
 * One admin account: its roles and state, and the two things a person may do
 * to it here — disable / re-enable it, or reset its password. Either ends that
 * account's open sessions (the server bumps its auth version).
 *
 * YOUR OWN ROW HAS NEITHER. Disabling yourself locks you out mid-task, and a
 * reset of your own password belongs behind your current password — the
 * sidebar's Change password asks for it.
 *
 * A refusal (the last super administrator, a password the server rejects) is
 * shown under this row, where the person pressed the button — the tab's banner
 * is out of sight with a long list. Successes still go to the banner, because
 * the list reloads.
 */
export default function AdminAccountRow({ user, isSelf, onChanged, flash }) {
  const [busy, setBusy] = React.useState(false);
  const [resetting, setResetting] = React.useState(false);
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [error, setError] = React.useState(null);

  const roleNames = (user.roles || []).map((r) => r.display_name).join(", ") || "—";
  const active = user.active !== false;
  const resetProblem = password.length < MIN_PASSWORD ? `At least ${MIN_PASSWORD} characters.`
    : password !== confirm ? "The two passwords do not match." : null;

  const run = async (work, success) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      flash("success", success);
      onChanged();
    } catch (err) {
      setError(err?.message || "Could not change the account.");
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = () => {
    const verb = active ? "Disable" : "Enable";
    const note = active ? " They are signed out and cannot sign in until enabled again." : "";
    if (!window.confirm(`${verb} ${user.username}?${note}`)) return;
    run(() => api.updateAdminUser(user.id, { active: !active }),
      active ? `${user.username} is disabled.` : `${user.username} can sign in again.`);
  };

  const submitReset = (e) => {
    e.preventDefault();
    if (resetProblem) return;
    run(async () => {
      await api.updateAdminUser(user.id, { password });
      setResetting(false); setPassword(""); setConfirm("");
    }, `${user.username}'s password was reset. Their open sessions have ended.`);
  };

  return (
    <>
      <tr>
        <td>
          <strong>{user.username}</strong>
          {isSelf && <span style={{ color: "var(--text-muted)" }}> (you)</span>}
        </td>
        <td>{roleNames}</td>
        <td>
          <span className={`badge ${active ? "badge-active" : "badge-inactive"}`}>{active ? "Active" : "Disabled"}</span>
        </td>
        <td style={{ color: "var(--text-muted)" }}>{user.last_login_at ? timeAgo(user.last_login_at) : "Never"}</td>
        <td style={{ whiteSpace: "nowrap" }}>
          {isSelf ? (
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Use Change password in the sidebar</span>
          ) : (
            <>
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setResetting((v) => !v)}>
                Reset password
              </button>{" "}
              <button type="button" className={`btn btn-sm ${active ? "btn-danger" : "btn-secondary"}`} disabled={busy} onClick={toggleActive}>
                {active ? "Disable" : "Enable"}
              </button>
            </>
          )}
        </td>
      </tr>
      {resetting && !isSelf && (
        <tr>
          <td colSpan={5}>
            <form onSubmit={submitReset} aria-label={`Reset password for ${user.username}`} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <input
                className="form-input" type="password" autoComplete="new-password" placeholder="New password"
                aria-label="New password" value={password} onChange={(e) => { setPassword(e.target.value); setError(null); }}
                style={{ maxWidth: 220 }}
              />
              <input
                className="form-input" type="password" autoComplete="new-password" placeholder="New password again"
                aria-label="New password again" value={confirm} onChange={(e) => { setConfirm(e.target.value); setError(null); }}
                style={{ maxWidth: 220 }}
              />
              <button type="submit" className="btn btn-primary btn-sm" disabled={busy || Boolean(resetProblem)}>Set password</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setResetting(false); setPassword(""); setConfirm(""); setError(null); }}>Cancel</button>
              {resetProblem && password && <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{resetProblem}</span>}
            </form>
          </td>
        </tr>
      )}
      {error && (
        <tr>
          <td colSpan={5}><div className="alert alert-error" role="alert" style={{ margin: 0 }}>{error}</div></td>
        </tr>
      )}
    </>
  );
}
