import React from "react";

import * as api from "../../../api";
import AdminAccountRow from "./AdminAccountRow";
import NewAdminForm from "./NewAdminForm";

/**
 * Settings → Administration → Admin Accounts: who can sign in to this panel.
 *
 * The server side (`server/routes/adminUserRoutes.js`, permission
 * `users.manage`) existed long before this screen; until the October 2026
 * audit an account could only be added, disabled or given a new password
 * through the database. What the server already guarantees, this screen relies
 * on rather than repeats: the last active super administrator can be neither
 * disabled nor demoted (`adminUserGuards.js`), and a password reset or a
 * disable ends that account's sessions.
 *
 * Deliberately not here yet: editing roles and their permissions (the role
 * editor) — an account is given its roles when it is created.
 */
export default function AdminAccountsTab() {
  const [users, setUsers] = React.useState([]);
  const [roles, setRoles] = React.useState([]);
  const [selfId, setSelfId] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [denied, setDenied] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [status, setStatus] = React.useState(null);
  const flash = React.useCallback((type, text) => setStatus({ type, text }), []);

  const load = React.useCallback(async () => {
    try {
      const [list, roleList, me] = await Promise.all([
        api.getAdminUsers(), api.getAdminRoles(), api.verifyAuth(),
      ]);
      setUsers(list);
      setRoles(roleList);
      setSelfId(me?.user?.id ?? null);
      setError(null);
    } catch (err) {
      if (err?.status === 403) setDenied(true);
      else setError(err?.message || "Could not load the admin accounts.");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  if (loading) return <div className="loading"><div className="spinner"></div> Loading…</div>;
  if (denied) {
    return (
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Admin Accounts</h3>
        <p style={{ marginBottom: 0 }}>
          Your account may not manage admin accounts — that needs the <code>users.manage</code> permission,
          which a super administrator has. Ask one to add or change an account for you.
        </p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="alert alert-error">
        {error}{" "}
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setLoading(true); load(); }}>Try again</button>
      </div>
    );
  }

  return (
    <div>
      {status && <div className={`alert alert-${status.type}`} style={{ marginBottom: 12 }}>{status.text}</div>}
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Admin Accounts</h3>
        <p style={{ color: "var(--text-secondary)", marginTop: 0 }}>
          Everyone who can sign in to this panel. Disabling an account or resetting its password signs that
          person out at once. The last active super administrator cannot be disabled.
        </p>
        <div className="table-container">
          <table className="table">
            <thead>
              <tr><th>Username</th><th>Roles</th><th>State</th><th>Last sign-in</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <AdminAccountRow
                  key={user.id} user={user} isSelf={Number(user.id) === Number(selfId)}
                  onChanged={load} flash={flash}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <NewAdminForm roles={roles} onCreated={load} flash={flash} />
    </div>
  );
}
