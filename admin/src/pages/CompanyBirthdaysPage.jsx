import React, { useState, useEffect, useCallback } from "react";
import * as api from "../api";
import { getDaysUntilBirthday, sortBySoonestBirthday } from "../components/Shared";

export default function CompanyBirthdaysPage() {
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState(null);
  const [requesting, setRequesting] = useState(false);

  const [newFn, setNewFn] = useState("");
  const [newLn, setNewLn] = useState("");
  const [newBd, setNewBd] = useState("");

  const [editingId, setEditingId] = useState(null);
  const [editFn, setEditFn] = useState("");
  const [editLn, setEditLn] = useState("");
  const [editBd, setEditBd] = useState("");

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getEmployeeBirthdays();
      setEmployees(sortBySoonestBirthday(data, (e) => e.birthday));
    } catch (err) {
      setStatus({ type: "error", text: err.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleManualAdd = async (e) => {
    e.preventDefault();
    if (!newFn || !newLn || !newBd) return;
    setRequesting(true);
    try {
      await api.createEmployeeBirthday({ firstName: newFn, lastName: newLn, birthday: newBd });
      setNewFn("");
      setNewLn("");
      setNewBd("");
      setStatus({ type: "success", text: "Employee added successfully!" });
      loadData();
    } catch (err) {
      setStatus({ type: "error", text: err.message });
    } finally {
      setRequesting(false);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm("Are you sure you want to delete this employee?")) return;
    try {
      await api.deleteEmployeeBirthday(id);
      setStatus({ type: "success", text: "Employee deleted." });
      loadData();
    } catch (err) {
      setStatus({ type: "error", text: err.message });
    }
  };

  const startEdit = (emp) => {
    setEditingId(emp.id);
    setEditFn(emp.first_name);
    setEditLn(emp.last_name);
    setEditBd((emp.birthday || "").split("T")[0]);
  };

  const handleUpdate = async (id) => {
    setRequesting(true);
    try {
      await api.updateEmployeeBirthday(id, { firstName: editFn, lastName: editLn, birthday: editBd });
      setEditingId(null);
      setStatus({ type: "success", text: "Employee updated!" });
      loadData();
    } catch (err) {
      setStatus({ type: "error", text: err.message });
    } finally {
      setRequesting(false);
    }
  };

  const handleSendRequest = async () => {
    if (!window.confirm("Send a message to the Employee Group asking for their birthdays?")) return;
    setRequesting(true);
    setStatus(null);
    try {
      await api.sendEmployeeBirthdayRequest();
      setStatus({ type: "success", text: "Request message sent to Employee Group!" });
    } catch (err) {
      setStatus({ type: "error", text: err.message });
    } finally {
      setRequesting(false);
    }
  };

  return (
    <div>
      <div className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2>🏢 Company Employee Birthdays</h2>
          <p>Manage office staff birthdays (soonest first). Bot congratulates them automatically at 9 AM CT.</p>
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          <button className="btn btn-ghost" onClick={loadData}>🔄 Refresh</button>
          <button className="btn btn-primary" onClick={handleSendRequest} disabled={requesting}>
            {requesting ? "⏳ Requesting..." : "💬 Send Telegram Request"}
          </button>
        </div>
      </div>

      {status && <div className={`alert alert-${status.type}`} style={{ marginBottom: 20 }}>{status.text}</div>}

      <div className="card" style={{ marginBottom: 24 }}>
        <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>➕ Manual Entry</h3>
        <form onSubmit={handleManualAdd} style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div className="form-group" style={{ flex: 1, minWidth: 150, marginBottom: 0 }}>
            <label>First Name</label>
            <input className="form-input" value={newFn} onChange={(e) => setNewFn(e.target.value)} required />
          </div>
          <div className="form-group" style={{ flex: 1, minWidth: 150, marginBottom: 0 }}>
            <label>Last Name</label>
            <input className="form-input" value={newLn} onChange={(e) => setNewLn(e.target.value)} required />
          </div>
          <div className="form-group" style={{ flex: 1, minWidth: 150, marginBottom: 0 }}>
            <label>Birthday</label>
            <input className="form-input" type="date" value={newBd} onChange={(e) => setNewBd(e.target.value)} required />
          </div>
          <button className="btn btn-primary" type="submit" disabled={requesting}>
            {requesting ? "⏳ Adding..." : "Add Employee"}
          </button>
        </form>
      </div>

      {loading ? (
        <div className="loading"><div className="spinner"></div> Loading...</div>
      ) : employees.length === 0 ? (
        <div className="empty-state">
          <div className="icon">🎂</div>
          <h3>No employee birthdays yet</h3>
          <p>Add them manually above or click &quot;Send Telegram Request&quot;.</p>
        </div>
      ) : (
        <div className="table-container">
          <table>
            <thead>
              <tr>
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
                      <td><input className="form-input" value={editFn} onChange={(e) => setEditFn(e.target.value)} /></td>
                      <td><input className="form-input" value={editLn} onChange={(e) => setEditLn(e.target.value)} /></td>
                      <td><input className="form-input" type="date" value={editBd} onChange={(e) => setEditBd(e.target.value)} /></td>
                      <td style={{ textAlign: "right" }}>
                        <button className="btn btn-primary btn-sm" onClick={() => handleUpdate(emp.id)} disabled={requesting} style={{ marginRight: 8 }}>
                          {requesting ? "⏳" : "Save"}
                        </button>
                        <button className="btn btn-ghost btn-sm" onClick={() => setEditingId(null)}>Cancel</button>
                      </td>
                    </>
                  ) : (
                    <>
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
                        <button className="btn btn-danger btn-sm" onClick={() => handleDelete(emp.id)}>Delete</button>
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
