import React, { useState, useEffect, useCallback } from "react";
import * as api from "../api";
import { getDaysUntilBirthday, sortBySoonestBirthday } from "../components/Shared";
import { friendlyTimezone } from "../utils/formatTime";

const TIMEZONE_OPTIONS = [
  "Asia/Tashkent",
  "America/Chicago",
  "America/New_York",
  "Europe/London",
  "UTC",
];

function formatSchedule(settings) {
  if (!settings) return "";
  const h = String(settings.sendHour ?? 0).padStart(2, "0");
  const m = String(settings.sendMinute ?? 0).padStart(2, "0");
  return `${h}:${m} ${settings.timezone || "Asia/Tashkent"}`;
}

function wishResultMessage(result) {
  if (!result) return "Done.";
  if (result.sent) {
    return `Sent birthday wishes to employee group for: ${result.names} (${result.provider || "ai"}).`;
  }
  if (result.reason === "already_sent") {
    return `Already sent today (${result.isoDate}). Scheduled run will be skipped.`;
  }
  if (result.reason === "no_birthdays") {
    return "No employees have a birthday today in the configured timezone.";
  }
  if (result.reason === "no_employee_group") {
    return "EMPLOYEE_GROUP_ID is not configured.";
  }
  return result.reason || "No action taken.";
}

export default function CompanyBirthdaysPage() {
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState(null);
  const [requesting, setRequesting] = useState(false);

  const [settings, setSettings] = useState(null);
  const [settingsForm, setSettingsForm] = useState({
    timezone: "Asia/Tashkent",
    sendHour: 0,
    sendMinute: 0,
    aiInstructions: "",
    fallbackTemplate: "",
  });
  const [savingSettings, setSavingSettings] = useState(false);

  const [selectedIds, setSelectedIds] = useState(new Set());
  const [customMessage, setCustomMessage] = useState("");

  const [newFn, setNewFn] = useState("");
  const [newLn, setNewLn] = useState("");
  const [newBd, setNewBd] = useState("");

  const [editingId, setEditingId] = useState(null);
  const [editFn, setEditFn] = useState("");
  const [editLn, setEditLn] = useState("");
  const [editBd, setEditBd] = useState("");
  const [confirmAction, setConfirmAction] = useState(null);

  const loadSettings = useCallback(async () => {
    try {
      const data = await api.getEmployeeBirthdaySettings();
      setSettings(data);
      setSettingsForm({
        timezone: data.timezone || "Asia/Tashkent",
        sendHour: data.sendHour ?? 0,
        sendMinute: data.sendMinute ?? 0,
        aiInstructions: data.aiInstructions || "",
        fallbackTemplate: data.fallbackTemplate || "",
      });
    } catch (err) {
      setStatus({ type: "error", text: err.message });
    }
  }, []);

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
    loadSettings();
    loadData();
  }, [loadSettings, loadData]);

  const toggleSelect = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === employees.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(employees.map((e) => e.id)));
    }
  };

  const handleSaveSettings = async (e) => {
    e.preventDefault();
    setSavingSettings(true);
    setStatus(null);
    try {
      const updated = await api.updateEmployeeBirthdaySettings(settingsForm);
      setSettings(updated);
      setStatus({ type: "success", text: `Settings saved. Scheduled wishes at ${formatSchedule(updated)}.` });
    } catch (err) {
      setStatus({ type: "error", text: err.message });
    } finally {
      setSavingSettings(false);
    }
  };

  const handleSendTodayNow = async () => {
    setRequesting(true);
    setStatus(null);
    try {
      const result = await api.sendEmployeeBirthdayWishesNow();
      setStatus({ type: result.sent ? "success" : "error", text: wishResultMessage(result) });
    } catch (err) {
      setStatus({ type: "error", text: err.message });
    } finally {
      setRequesting(false);
    }
  };

  const handleCongratulateSelected = async () => {
    const ids = Array.from(selectedIds);
    if (!ids.length) return;
    setRequesting(true);
    setStatus(null);
    try {
      const result = await api.congratulateEmployees(ids);
      setStatus({ type: result.sent ? "success" : "error", text: wishResultMessage(result) });
    } catch (err) {
      setStatus({ type: "error", text: err.message });
    } finally {
      setRequesting(false);
    }
  };

  const handleSendCustom = async () => {
    const msg = customMessage.trim();
    if (!msg) return;
    setRequesting(true);
    setStatus(null);
    try {
      await api.sendEmployeeGroupCustomMessage(msg);
      setCustomMessage("");
      setStatus({ type: "success", text: "Custom message sent to employee group." });
    } catch (err) {
      setStatus({ type: "error", text: err.message });
    } finally {
      setRequesting(false);
    }
  };

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
    try {
      await api.deleteEmployeeBirthday(id);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
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
      <div className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h2>🎂 Birthdays</h2>
          <p>
            Manage office staff birthdays (soonest first).
            {settings ? (
              <> Automatic AI wishes at <strong>{formatSchedule(settings)}</strong>.</>
            ) : (
              " Loading schedule..."
            )}
          </p>
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <button className="btn btn-ghost" onClick={() => { loadData(); loadSettings(); }}>🔄 Refresh</button>
          <button className="btn btn-primary" onClick={handleSendRequest} disabled={requesting}>
            {requesting ? "⏳ Requesting..." : "💬 Send Telegram Request"}
          </button>
        </div>
      </div>

      {status && <div className={`alert alert-${status.type}`} style={{ marginBottom: 20 }}>{status.text}</div>}

      <div className="card" style={{ marginBottom: 24 }}>
        <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>🎂 Birthday Wishes Settings</h3>
        <form onSubmit={handleSaveSettings}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, marginBottom: 16 }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Timezone</label>
              <select
                className="form-input"
                value={settingsForm.timezone}
                onChange={(e) => setSettingsForm((s) => ({ ...s, timezone: e.target.value }))}
              >
                {TIMEZONE_OPTIONS.map((tz) => (
                  <option key={tz} value={tz}>{friendlyTimezone(tz)} ({tz})</option>
                ))}
              </select>
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Hour (0–23)</label>
              <input
                className="form-input"
                type="number"
                min={0}
                max={23}
                value={settingsForm.sendHour}
                onChange={(e) => setSettingsForm((s) => ({ ...s, sendHour: Number(e.target.value) }))}
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Minute (0–59)</label>
              <input
                className="form-input"
                type="number"
                min={0}
                max={59}
                value={settingsForm.sendMinute}
                onChange={(e) => setSettingsForm((s) => ({ ...s, sendMinute: Number(e.target.value) }))}
              />
            </div>
          </div>
          <div className="form-group">
            <label>AI instructions (tone and style — each send uses unique wording)</label>
            <textarea
              className="form-input"
              rows={3}
              value={settingsForm.aiInstructions}
              onChange={(e) => setSettingsForm((s) => ({ ...s, aiInstructions: e.target.value }))}
            />
          </div>
          <div className="form-group">
            <label>Fallback template (use {"{names}"} placeholder; used if AI unavailable)</label>
            <textarea
              className="form-input"
              rows={4}
              value={settingsForm.fallbackTemplate}
              onChange={(e) => setSettingsForm((s) => ({ ...s, fallbackTemplate: e.target.value }))}
            />
          </div>
          <button className="btn btn-primary" type="submit" disabled={savingSettings}>
            {savingSettings ? "Saving..." : "Save settings"}
          </button>
        </form>

        <div style={{ marginTop: 20, paddingTop: 20, borderTop: "1px solid var(--border)", display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-start" }}>
          <button className="btn btn-primary" type="button" onClick={() => setConfirmAction({ type: 'sendToday' })} disabled={requesting}>
            Send today&apos;s wishes now
          </button>
          <button
            className="btn btn-ghost"
            type="button"
            onClick={() => setConfirmAction({ type: 'congratulate', ids: Array.from(selectedIds) })}
            disabled={requesting || selectedIds.size === 0}
          >
            Congratulate selected ({selectedIds.size})
          </button>
          <div style={{ flex: 1, minWidth: 260, display: "flex", gap: 8, alignItems: "flex-end" }}>
            <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
              <label>Custom message to employee group</label>
              <textarea
                className="form-input"
                rows={2}
                value={customMessage}
                onChange={(e) => setCustomMessage(e.target.value)}
                placeholder="HTML allowed: &lt;b&gt;, &lt;i&gt;"
              />
            </div>
            <button className="btn btn-ghost" type="button" onClick={() => setConfirmAction({ type: 'custom' })} disabled={requesting || !customMessage.trim()}>
              Send custom
            </button>
          </div>
        </div>
      </div>

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
                <th style={{ width: 40 }}>
                  <input
                    type="checkbox"
                    checked={employees.length > 0 && selectedIds.size === employees.length}
                    onChange={toggleSelectAll}
                    title="Select all"
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
                      <td>
                        <input
                          type="checkbox"
                          checked={selectedIds.has(emp.id)}
                          onChange={() => toggleSelect(emp.id)}
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
                        <button className="btn btn-danger btn-sm" onClick={() => setConfirmAction({ type: 'delete', id: emp.id })}>Delete</button>
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {confirmAction && (
        <div className="confirm-overlay" onClick={() => setConfirmAction(null)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>
              {confirmAction.type === 'delete' ? '🗑️ Remove Employee?' :
               confirmAction.type === 'sendToday' ? '🎂 Send Birthday Wishes?' :
               confirmAction.type === 'congratulate' ? `🎂 Congratulate ${confirmAction.ids?.length} Employee(s)?` :
               confirmAction.type === 'custom' ? '💬 Send Custom Message?' :
               confirmAction.type === 'request' ? '💬 Request Birthdays?' : 'Confirm'}
            </h3>
            <p>
              {confirmAction.type === 'delete' ? 'This will permanently remove this employee from the birthday list.' :
               confirmAction.type === 'sendToday' ? "This sends today's birthday wishes to the employee group now and blocks the scheduled send for today." :
               confirmAction.type === 'congratulate' ? `AI-generated birthday wishes will be sent for ${confirmAction.ids?.length} selected employee(s).` :
               confirmAction.type === 'custom' ? 'This sends your custom message to the employee group.' :
               confirmAction.type === 'request' ? 'This sends a message asking all employees for their birthdays.' : 'Are you sure?'}
            </p>
            <div className="confirm-actions">
              <button className="btn btn-ghost" onClick={() => setConfirmAction(null)}>Cancel</button>
              <button
                className={confirmAction.type === 'delete' ? 'btn btn-danger' : 'btn btn-primary'}
                onClick={async () => {
                  const action = confirmAction;
                  setConfirmAction(null);
                  if (action.type === 'delete') await handleDelete(action.id);
                  else if (action.type === 'sendToday') await handleSendTodayNow();
                  else if (action.type === 'congratulate') await handleCongratulateSelected();
                  else if (action.type === 'custom') await handleSendCustom();
                  else if (action.type === 'request') await handleSendRequest();
                }}
              >
                {confirmAction.type === 'delete' ? 'Remove' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
