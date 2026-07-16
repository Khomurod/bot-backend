import React, { useMemo, useState } from "react";
import api from "../../api/trailerDepartment";
import { useAuth } from "../../context/AuthContext";
import {
  Alert,
  Card,
  Empty,
  Field,
  PageHeader,
  Status,
  Table,
  useLoad,
} from "./TrailerUi";
export default function TrailerUsersPage() {
  const { isSuperAdmin } = useAuth();
  const users = useLoad(() => api.adminUsers(), []),
    roles = useLoad(() => api.roles(), []);
  const [edit, setEdit] = useState(null),
    [msg, setMsg] = useState(null),
    [roleEdit, setRoleEdit] = useState(null);
  const trailerRoles = useMemo(
    () =>
      (roles.data?.roles || []).filter((r) =>
        r.system_key.startsWith("trailer_"),
      ),
    [roles.data],
  );
  const open = (row = { active: true, roles: [] }) =>
    setEdit({
      ...row,
      password: "",
      role_ids: (row.roles || []).map((r) => r.id),
    });
  const save = async () => {
    try {
      await api.saveAdminUser(edit.id, {
        username: edit.username,
        password: edit.password || undefined,
        active: edit.active,
        role_ids: edit.role_ids,
      });
      setMsg({ text: "Trailer user saved." });
      setEdit(null);
      users.reload();
    } catch (e) {
      setMsg({ type: "error", text: e.message });
    }
  };
  const saveRole = async () => {
    try {
      await api.saveRole(roleEdit.id, { display_name: roleEdit.display_name, description: roleEdit.description, active: roleEdit.active, permission_keys: roleEdit.permissions });
      setMsg({ text: "Role permissions saved." }); setRoleEdit(null); roles.reload();
    } catch (e) { setMsg({ type: "error", text: e.message }); }
  };
  return (
    <div>
      <PageHeader
        title="Trailer Users"
        subtitle="Accounts and trailer roles are separate from observed Telegram users."
        actions={
          <button className="btn btn-primary" onClick={() => open()}>
            Add user
          </button>
        }
      />
      <Alert message={msg} />
      {users.error && <div className="alert alert-danger">{users.error}</div>}
      {users.loading ? (
        <div className="loading">Loading…</div>
      ) : !users.data?.users?.length ? (
        <Empty />
      ) : (
        <Table
          rows={users.data.users}
          onRow={open}
          columns={[
            { key: "username", label: "Username" },
            {
              key: "active",
              label: "Status",
              render: (r) => (
                <Status value={r.active ? "active" : "inactive"} />
              ),
            },
            {
              key: "roles",
              label: "Roles",
              render: (r) =>
                (r.roles || []).map((x) => x.display_name).join(", "),
            },
            { key: "last_login_at", label: "Last login" },
          ]}
        />
      )}{" "}
      {isSuperAdmin && <Card><h3>Roles and permissions</h3><div className="trailer-role-grid">{(roles.data?.roles || []).map((role) => <button className="btn btn-secondary" key={role.id} onClick={() => setRoleEdit({ ...role, permissions: [...role.permissions] })}>{role.display_name}</button>)}</div></Card>}
      {edit && (
        <div className="trailer-modal-backdrop">
          <Card className="trailer-modal">
            <PageHeader
              title={edit.id ? "Edit trailer user" : "New trailer user"}
              actions={
                <button className="btn btn-ghost" onClick={() => setEdit(null)}>
                  Close
                </button>
              }
            />
            <Field label="Username">
              <input
                autoComplete="username"
                value={edit.username || ""}
                onChange={(e) => setEdit({ ...edit, username: e.target.value })}
              />
            </Field>
            <Field label={edit.id ? "New password (optional)" : "Password"}>
              <input
                type="password"
                autoComplete="new-password"
                value={edit.password}
                onChange={(e) => setEdit({ ...edit, password: e.target.value })}
              />
            </Field>
            <fieldset>
              <legend>Roles</legend>
              {trailerRoles.map((role) => (
                <label className="trailer-check" key={role.id}>
                  <input
                    type="checkbox"
                    checked={edit.role_ids.includes(role.id)}
                    onChange={(e) =>
                      setEdit({
                        ...edit,
                        role_ids: e.target.checked
                          ? [...edit.role_ids, role.id]
                          : edit.role_ids.filter((id) => id !== role.id),
                      })
                    }
                  />
                  {role.display_name}
                </label>
              ))}
            </fieldset>
            <label className="trailer-check">
              <input
                type="checkbox"
                checked={edit.active}
                onChange={(e) => setEdit({ ...edit, active: e.target.checked })}
              />{" "}
              Active account
            </label>
            <button className="btn btn-primary" onClick={save}>
              Save user
            </button>
          </Card>
        </div>
      )}
      {roleEdit && <div className="trailer-modal-backdrop"><Card className="trailer-modal"><PageHeader title="Edit role" actions={<button className="btn btn-ghost" onClick={() => setRoleEdit(null)}>Close</button>}/><Field label="Display name"><input value={roleEdit.display_name} onChange={(e) => setRoleEdit({ ...roleEdit, display_name: e.target.value })}/></Field><Field label="Description"><textarea value={roleEdit.description || ""} onChange={(e) => setRoleEdit({ ...roleEdit, description: e.target.value })}/></Field><fieldset><legend>Permissions</legend>{(roles.data?.permissions || []).map((permission) => <label className="trailer-check" key={permission.permission_key}><input type="checkbox" checked={roleEdit.permissions.includes(permission.permission_key)} onChange={(e) => setRoleEdit({ ...roleEdit, permissions: e.target.checked ? [...roleEdit.permissions, permission.permission_key] : roleEdit.permissions.filter((key) => key !== permission.permission_key) })}/>{permission.permission_key}</label>)}</fieldset><label className="trailer-check"><input type="checkbox" checked={roleEdit.active} onChange={(e) => setRoleEdit({ ...roleEdit, active: e.target.checked })}/> Active role</label><button className="btn btn-primary" onClick={saveRole}>Save role</button></Card></div>}
    </div>
  );
}
