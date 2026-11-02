import React, { useState, useEffect, useCallback } from "react";
import * as api from "../api";
import { sortBySoonestBirthday } from "../components/Shared";
import ConfirmDialog from "../components/ConfirmDialog";
import AddEmployeeForm from "./birthdays/AddEmployeeForm";
import EmployeeBirthdayTable from "./birthdays/EmployeeBirthdayTable";
import PostingTimeLine from "./birthdays/PostingTimeLine";
import { confirmCopy, formatSchedule, wishResultMessage } from "./birthdays/companyBirthdayText";

/**
 * Birthdays → Birthdays: office staff and the cards posted for them.
 *
 * Laid out in November 2026 (docs/redesign/density.md E3). The posting time
 * is one line with Change. Every send sits in one toolbar above the table:
 * today's wishes, the ticked rows, a custom message, and the request for
 * birthdays. The table follows. "Add employee" opens its form only when asked.
 * Every send and every delete asks first.
 */
export default function CompanyBirthdaysPage() {
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState(null);
  const [requesting, setRequesting] = useState(false);
  const [settings, setSettings] = useState(null);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [customOpen, setCustomOpen] = useState(false);
  const [customMessage, setCustomMessage] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState(null);

  const fail = useCallback((text) => setStatus({ type: "error", text }), []);

  const loadSettings = useCallback(async () => {
    try {
      setSettings(await api.getEmployeeBirthdaySettings());
    } catch (err) {
      fail(err.message);
    }
  }, [fail]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getEmployeeBirthdays();
      setEmployees(sortBySoonestBirthday(data, (e) => e.birthday));
    } catch (err) {
      fail(err.message);
    } finally {
      setLoading(false);
    }
  }, [fail]);

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
    setSelectedIds(selectedIds.size === employees.length ? new Set() : new Set(employees.map((e) => e.id)));
  };

  // One send at a time: the toolbar is disabled while any of them runs.
  const send = async (request, onSuccess) => {
    setRequesting(true);
    setStatus(null);
    try {
      onSuccess(await request());
    } catch (err) {
      fail(err.message);
    } finally {
      setRequesting(false);
    }
  };

  const wishResult = (result) => setStatus({ type: result.sent ? "success" : "error", text: wishResultMessage(result) });

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
      fail(err.message);
    }
  };

  const runConfirmed = async (action) => {
    setConfirmAction(null);
    if (action.type === "delete") await handleDelete(action.id);
    else if (action.type === "sendToday") await send(() => api.sendEmployeeBirthdayWishesNow(), wishResult);
    else if (action.type === "congratulate") await send(() => api.congratulateEmployees(action.ids), wishResult);
    else if (action.type === "custom") {
      await send(() => api.sendEmployeeGroupCustomMessage(customMessage.trim()), () => {
        setCustomMessage("");
        setCustomOpen(false);
        setStatus({ type: "success", text: "Custom message sent to employee group." });
      });
    } else if (action.type === "request") {
      await send(() => api.sendEmployeeBirthdayRequest(), () => {
        setStatus({ type: "success", text: "Request message sent to Employee Group!" });
      });
    }
  };

  const copy = confirmAction && confirmCopy(confirmAction);

  return (
    <div>
      <div className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <p style={{ margin: 0 }}>
          Office staff birthdays, soonest first. American names, Telegram accounts and photos are on the Employees tab.
        </p>
        <button className="btn btn-ghost" onClick={() => { loadData(); loadSettings(); }}>🔄 Refresh</button>
      </div>

      <PostingTimeLine
        settings={settings}
        onSaved={(updated) => {
          setSettings(updated);
          setStatus({ type: "success", text: `Settings saved. Scheduled wishes at ${formatSchedule(updated)}.` });
        }}
        onError={fail}
      />

      {status && <div className={`alert alert-${status.type}`} style={{ marginBottom: 16 }}>{status.text}</div>}

      <div role="toolbar" aria-label="Birthday actions" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
        <button className="btn btn-primary" type="button" onClick={() => setConfirmAction({ type: "sendToday" })} disabled={requesting}>
          Send today&apos;s wishes now
        </button>
        <button
          className="btn btn-ghost" type="button" disabled={requesting || selectedIds.size === 0}
          onClick={() => setConfirmAction({ type: "congratulate", ids: Array.from(selectedIds) })}
        >
          Congratulate selected ({selectedIds.size})
        </button>
        <button className="btn btn-ghost" type="button" aria-expanded={customOpen} onClick={() => setCustomOpen((v) => !v)}>
          Custom message…
        </button>
        {/* Posts to the whole employee group, so it asks first like every other send here. */}
        <button className="btn btn-ghost" type="button" onClick={() => setConfirmAction({ type: "request" })} disabled={requesting}>
          {requesting ? "⏳ Requesting..." : "💬 Send Telegram Request"}
        </button>
        <span style={{ flex: 1 }} />
        <button className="btn btn-ghost" type="button" aria-expanded={addOpen} onClick={() => setAddOpen((v) => !v)}>
          + Add employee
        </button>
      </div>

      {customOpen && (
        <div className="card" style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 16 }}>
          <div className="form-group" style={{ flex: 1, minWidth: 260, marginBottom: 0 }}>
            <label htmlFor="bd-custom">Custom message to employee group</label>
            <textarea
              id="bd-custom" className="form-input" rows={2} value={customMessage}
              onChange={(e) => setCustomMessage(e.target.value)} placeholder="HTML allowed: &lt;b&gt;, &lt;i&gt;"
            />
          </div>
          <button className="btn btn-primary" type="button" onClick={() => setConfirmAction({ type: "custom" })} disabled={requesting || !customMessage.trim()}>
            Send custom
          </button>
        </div>
      )}

      {addOpen && (
        <AddEmployeeForm
          onAdded={() => {
            setAddOpen(false);
            setStatus({ type: "success", text: "Employee added successfully!" });
            loadData();
          }}
          onError={fail}
          onClose={() => setAddOpen(false)}
        />
      )}

      {loading ? (
        <div className="loading"><div className="spinner"></div> Loading...</div>
      ) : employees.length === 0 ? (
        <div className="empty-state">
          <div className="icon">🎂</div>
          <h3>No employee birthdays yet</h3>
          <p>Use &quot;Add employee&quot; or &quot;Send Telegram Request&quot; above.</p>
        </div>
      ) : (
        <EmployeeBirthdayTable
          employees={employees}
          selectedIds={selectedIds}
          onToggle={toggleSelect}
          onToggleAll={toggleSelectAll}
          onAskDelete={(id) => setConfirmAction({ type: "delete", id })}
          onUpdated={() => {
            setStatus({ type: "success", text: "Employee updated!" });
            loadData();
          }}
          onError={fail}
        />
      )}

      {confirmAction && (
        <ConfirmDialog
          title={copy.title}
          confirmLabel={copy.label}
          danger={copy.danger}
          onCancel={() => setConfirmAction(null)}
          onConfirm={() => runConfirmed(confirmAction)}
        >
          {copy.body}
        </ConfirmDialog>
      )}
    </div>
  );
}
