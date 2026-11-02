import React, { useState } from "react";

import * as api from "../../api";
import { getDaysUntilBirthday } from "../../components/Shared";

/**
 * Office staff and their birthdays, soonest first. Tick rows to congratulate
 * them from the toolbar; Edit changes a row in place; Delete asks first (the
 * page owns that confirm).
 */
export default function EmployeeBirthdayTable({
  employees, selectedIds, onToggle, onToggleAll, onAskDelete, onUpdated, onError,
}) {
  const [editingId, setEditingId] = useState(null);
  const [edit, setEdit] = useState({ firstName: "", lastName: "", birthday: "" });
  const [saving, setSaving] = useState(false);

  const startEdit = (emp) => {
    setEditingId(emp.id);
    setEdit({ firstName: emp.first_name, lastName: emp.last_name, birthday: (emp.birthday || "").split("T")[0] });
  };

  const save = async (id) => {
    setSaving(true);
    try {
      await api.updateEmployeeBirthday(id, edit);
      setEditingId(null);
      onUpdated();
    } catch (err) {
      onError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const field = (key) => (e) => setEdit((s) => ({ ...s, [key]: e.target.value }));

  return (
    <div className="table-container">
      <table>
        <thead>
          <tr>
            <th style={{ width: 40 }}>
              <input
                type="checkbox"
                checked={employees.length > 0 && selectedIds.size === employees.length}
                onChange={onToggleAll}
                title="Select all"
                aria-label="Select all"
              />
            </th>
            <th>First Name</th>
            <th>Last Name</th>
            <th>Birthday</th>
            <th style={{ textAlign: "right" }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {employees.map((emp) => (
            <tr key={emp.id}>
              {editingId === emp.id ? (
                <>
                  <td />
                  <td><input className="form-input" aria-label="First name" value={edit.firstName} onChange={field("firstName")} /></td>
                  <td><input className="form-input" aria-label="Last name" value={edit.lastName} onChange={field("lastName")} /></td>
                  <td><input className="form-input" aria-label="Birthday" type="date" value={edit.birthday} onChange={field("birthday")} /></td>
                  <td style={{ textAlign: "right" }}>
                    <button className="btn btn-primary btn-sm" onClick={() => save(emp.id)} disabled={saving} style={{ marginRight: 8 }}>
                      {saving ? "⏳" : "Save"}
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => setEditingId(null)}>Cancel</button>
                  </td>
                </>
              ) : (
                <>
                  <td>
                    <input
                      type="checkbox"
                      checked={selectedIds.has(emp.id)}
                      onChange={() => onToggle(emp.id)}
                      aria-label={`Select ${emp.first_name} ${emp.last_name}`}
                    />
                  </td>
                  <td><strong>{emp.first_name}</strong></td>
                  <td>{emp.last_name}</td>
                  <td>
                    <span className="badge badge-active">
                      {new Date(emp.birthday).toLocaleDateString(undefined, { timeZone: "UTC" })}
                      {getDaysUntilBirthday(emp.birthday) <= 7 && (
                        <> (in {getDaysUntilBirthday(emp.birthday)}d)</>
                      )}
                    </span>
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => startEdit(emp)} style={{ marginRight: 8 }}>Edit</button>
                    <button className="btn btn-danger btn-sm" onClick={() => onAskDelete(emp.id)}>Delete</button>
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
