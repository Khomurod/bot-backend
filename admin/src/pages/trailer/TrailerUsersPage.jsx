import React, { useMemo, useState } from "react";
import api from "../../api/trailerDepartment";
import { useAuth } from "../../context/AuthContext";
import {
  Alert,
  Card,
  Empty,
  Field,
  Modal,
  PageHeader,
  Status,
  Table,
  useLoad,
} from "./TrailerUi";
import { groupPermissions } from "./a11y/permissionLabels";

/**
 * Permission checklist with PLAIN-LANGUAGE labels (§7): the sentence is the
 * primary label; the raw key appears only as secondary small text.
 */
function PermissionChecklist({ permissions, checked, onToggle }) {
  return groupPermissions(permissions).map(({ group, items }) => (
    <fieldset key={group}>
      <legend>{group}</legend>
      {items.map(({ key, label }) => (
        <label className="trailer-check" key={key}>
          <input
            type="checkbox"
            checked={checked.includes(key)}
            onChange={(e) => onToggle(key, e.target.checked)}
          />
          <span>
            {label}
            <small className="trailer-help" style={{ display: "block" }}>{key}</small>
          </span>
        </label>
      ))}
    </fieldset>
  ));
}

/** One dialog for creating a new role or editing an existing one. */
function RoleDialog({ role, permissions, onClose, onSaved }) {
  const creating = !role.id;
  const [form, setForm] = useState({
    display_name: role.display_name || "",
    description: role.description || "",
    active: role.active !== false,
    permission_keys: [...(role.permissions || [])],
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    if (!form.display_name.trim()) { setError("A role name is required."); return; }
    setBusy(true);
    setError("");
    try {
      if (creating) await api.createRole(form);
      // Send the current version so a concurrent edit is a 409, not an overwrite.
      else await api.saveRole(role.id, { ...form, version: role.version });
      onSaved(creating ? `Role "${form.display_name}" created.` : "Role saved.");
    } catch (e) { setError(e.message); setBusy(false); }
  };

  return (
    <Modal title={creating ? "Create a role" : `Edit role — ${role.display_name}`}
      subtitle="Pick exactly what people with this role may do."
      onClose={busy ? undefined : onClose} wide>
      {error && <div className="alert alert-danger" role="alert">{error}</div>}
      <Field label="Role name">
        <input value={form.display_name}
          onChange={(e) => setForm({ ...form, display_name: e.target.value })} />
      </Field>
      <Field label="Description (what this role is for)">
        <textarea value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })} />
      </Field>
      <PermissionChecklist
        permissions={permissions}
        checked={form.permission_keys}
        onToggle={(key, on) => setForm({
          ...form,
          permission_keys: on
            ? [...form.permission_keys, key]
            : form.permission_keys.filter((k) => k !== key),
        })}
      />
      {!creating && (
        <label className="trailer-check">
          <input type="checkbox" checked={form.active}
            onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Active role
        </label>
      )}
      <div className="trailer-actions" style={{ marginTop: 12 }}>
        <button className="btn btn-secondary" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy} onClick={save}>
          {busy ? "Saving…" : creating ? "Create role" : "Save role"}
        </button>
      </div>
    </Modal>
  );
}

export default function TrailerUsersPage() {
  const { isSuperAdmin } = useAuth();
  const users = useLoad(() => api.adminUsers(), []),
    roles = useLoad(() => api.roles(), []);
  const [edit, setEdit] = useState(null),
    [msg, setMsg] = useState(null),
    [roleEdit, setRoleEdit] = useState(null);
  const trailerRoles = useMemo(
    () =>
      // Assignable from this page: department roles and department-created
      // custom roles. A legacy custom role may have no system_key — guard it.
      (roles.data?.roles || []).filter((r) =>
        String(r.system_key || "").startsWith("trailer_")
        || String(r.system_key || "").startsWith("custom_"),
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
      {isSuperAdmin && (
        <Card>
          <div className="trailer-actions" style={{ justifyContent: "space-between" }}>
            <h3>Roles and permissions</h3>
            <button className="btn btn-primary" onClick={() => setRoleEdit({ permissions: [] })}>
              Create role
            </button>
          </div>
          <div className="trailer-role-grid">
            {(roles.data?.roles || []).map((role) => (
              <button className="btn btn-secondary" key={role.id}
                onClick={() => setRoleEdit({ ...role, permissions: [...role.permissions] })}>
                {role.display_name}{role.active === false ? " (inactive)" : ""}
              </button>
            ))}
          </div>
        </Card>
      )}
      {edit && (
        <Modal
          title={edit.id ? "Edit trailer user" : "New trailer user"}
          onClose={() => setEdit(null)}
        >
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
        </Modal>
      )}
      {roleEdit && (
        <RoleDialog
          role={roleEdit}
          permissions={roles.data?.permissions || []}
          onClose={() => setRoleEdit(null)}
          onSaved={(text) => { setMsg({ text }); setRoleEdit(null); roles.reload(); }}
        />
      )}
    </div>
  );
}
