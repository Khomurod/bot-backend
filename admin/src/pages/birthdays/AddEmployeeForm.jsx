import React, { useState } from "react";

import * as api from "../../api";

/**
 * Add one employee by hand: first name, last name, birthday. It opens from
 * the toolbar's "Add employee" and closes after a successful add.
 */
export default function AddEmployeeForm({ onAdded, onError, onClose }) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [birthday, setBirthday] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!firstName || !lastName || !birthday) return;
    setSaving(true);
    try {
      await api.createEmployeeBirthday({ firstName, lastName, birthday });
      onAdded();
    } catch (err) {
      onError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={submit} aria-label="Add employee" className="card"
      style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 16 }}
    >
      <div className="form-group" style={{ flex: 1, minWidth: 150, marginBottom: 0 }}>
        <label htmlFor="bd-new-first">First Name</label>
        <input id="bd-new-first" className="form-input" value={firstName} onChange={(e) => setFirstName(e.target.value)} required />
      </div>
      <div className="form-group" style={{ flex: 1, minWidth: 150, marginBottom: 0 }}>
        <label htmlFor="bd-new-last">Last Name</label>
        <input id="bd-new-last" className="form-input" value={lastName} onChange={(e) => setLastName(e.target.value)} required />
      </div>
      <div className="form-group" style={{ flex: 1, minWidth: 150, marginBottom: 0 }}>
        <label htmlFor="bd-new-birthday">Birthday</label>
        <input
          id="bd-new-birthday" className="form-input" type="date" value={birthday}
          onChange={(e) => setBirthday(e.target.value)} required
        />
      </div>
      <button className="btn btn-primary" type="submit" disabled={saving}>
        {saving ? "⏳ Adding..." : "Add"}
      </button>
      <button className="btn btn-ghost" type="button" disabled={saving} onClick={onClose}>Cancel</button>
    </form>
  );
}
