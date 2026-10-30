import React from "react";

import * as api from "../api";

const MIN_PASSWORD = 10;

/**
 * Change your own password: the current one, the new one twice.
 *
 * The server ends every session of this account when the password changes
 * (`POST /api/auth/change-password` bumps its auth version), so success says so
 * and offers the sign-in screen rather than leaving a person on a page whose
 * next request would fail. Open to every signed-in account, including one
 * without full access — it is the sidebar's, not a section's.
 */
export default function ChangePasswordModal({ onClose, onSignInAgain }) {
  const [current, setCurrent] = React.useState("");
  const [next, setNext] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [done, setDone] = React.useState(false);

  const problem = !current ? "Enter your current password."
    : next.length < MIN_PASSWORD ? `The new password needs at least ${MIN_PASSWORD} characters.`
      : next !== confirm ? "The two new passwords do not match."
        : next === current ? "The new password is the same as the current one."
          : null;

  const submit = async (e) => {
    e.preventDefault();
    if (problem) return;
    setSaving(true);
    setError(null);
    try {
      await api.changePassword(current, next);
      setDone(true);
    } catch (err) {
      setError(err?.message || "Could not change the password.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="home-time-modal-backdrop" onClick={done ? undefined : onClose}>
      <div
        className="card home-time-modal-card" role="dialog" aria-modal="true" aria-labelledby="change-password-title"
        style={{ width: "min(440px, 100%)" }} onClick={(e) => e.stopPropagation()}
      >
        <h3 id="change-password-title" style={{ marginTop: 0 }}>Change password</h3>
        {done ? (
          <>
            <p>Your password was changed. Every session of this account has ended, including this one.</p>
            <button type="button" className="btn btn-primary" onClick={onSignInAgain}>Sign in again</button>
          </>
        ) : (
          <form onSubmit={submit}>
            <div className="form-group">
              <label htmlFor="cp-current">Current password</label>
              <input id="cp-current" className="form-input" type="password" autoComplete="current-password"
                value={current} onChange={(e) => setCurrent(e.target.value)} />
            </div>
            <div className="form-group">
              <label htmlFor="cp-new">New password</label>
              <input id="cp-new" className="form-input" type="password" autoComplete="new-password"
                value={next} onChange={(e) => setNext(e.target.value)} />
            </div>
            <div className="form-group">
              <label htmlFor="cp-confirm">New password again</label>
              <input id="cp-confirm" className="form-input" type="password" autoComplete="new-password"
                value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </div>
            {error && <div className="alert alert-error" style={{ marginBottom: 8 }}>{error}</div>}
            {problem && (current || next || confirm) && (
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>{problem}</div>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <button type="submit" className="btn btn-primary" disabled={saving || Boolean(problem)}>
                {saving ? "Changing…" : "Change password"}
              </button>
              <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
