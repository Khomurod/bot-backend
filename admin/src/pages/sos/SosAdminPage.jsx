/**
 * Admin — QBQ / SOS assessment section (full administrators only; the server
 * enforces admin.full_access on every /api/sos/admin endpoint).
 *
 * Status + open/close control, completion counts, filterable submissions list
 * with CSV export, per-submission detail, delete, and clear-all test data.
 */
import { useEffect, useState } from "react";
import {
  getSosAdminStatus, setSosOpen, listSosSubmissions, getSosSubmissionDetail,
  deleteSosSubmission, clearSosSubmissions, downloadSosCsv,
} from "../../api/sos";
import SosSubmissionsTable from "./SosSubmissionsTable";
import SosSubmissionDetail from "./SosSubmissionDetail";

const DEPARTMENT_LABELS = {
  hr: "HR / Recruiting", safety: "Safety", dispatch: "Dispatch", trailer: "Trailer",
  samsara: "Samsara Monitoring", accounting: "Accounting", updaters: "Updaters",
};

export default function SosAdminPage() {
  const [status, setStatus] = useState(null);
  const [rows, setRows] = useState([]);
  const [filters, setFilters] = useState({ department: "", pattern: "", search: "" });
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function loadStatus() {
    try { setStatus(await getSosAdminStatus()); } catch (err) { setError(err.message); }
  }

  async function loadRows(activeFilters = filters) {
    try {
      const data = await listSosSubmissions(activeFilters);
      setRows(data.submissions);
      setError("");
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { loadStatus(); loadRows(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function toggleOpen() {
    if (!status) return;
    setBusy(true);
    try {
      await setSosOpen(!status.open);
      await loadStatus();
      setNotice(status.open ? "Questionnaire closed — submissions are now blocked." : "Questionnaire reopened.");
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function openDetail(id) {
    setBusy(true);
    try { setDetail(await getSosSubmissionDetail(id)); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function removeSubmission(id) {
    if (!window.confirm(`Delete submission #${id}? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await deleteSosSubmission(id);
      setDetail(null);
      setNotice(`Submission #${id} deleted.`);
      await Promise.all([loadStatus(), loadRows()]);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function clearAll() {
    const phrase = window.prompt('This deletes EVERY submission (e.g. to clear test data before the real event).\nType DELETE ALL to confirm:');
    if (phrase !== "DELETE ALL") return;
    setBusy(true);
    try {
      const res = await clearSosSubmissions();
      setDetail(null);
      setNotice(`Cleared ${res.deleted} submission(s).`);
      await Promise.all([loadStatus(), loadRows()]);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  function applyFilters(next) {
    setFilters(next);
    loadRows(next);
  }

  return (
    <div>
      <h2 style={{ marginBottom: 16 }}>🧭 QBQ / SOS Assessment</h2>

      {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}
      {notice && <div className="alert alert-success" style={{ marginBottom: 12 }}>{notice}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 24, alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 13, opacity: 0.7 }}>Status</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: status?.open ? "#22c55e" : "#f87171" }}>
              {status ? (status.open ? "● Open" : "● Closed") : "…"}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 13, opacity: 0.7 }}>Completed</div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{status?.total ?? "…"}</div>
          </div>
          <div>
            <div style={{ fontSize: 13, opacity: 0.7 }}>Last submission</div>
            <div style={{ fontSize: 14 }}>{status?.lastSubmissionAt ? new Date(status.lastSubmissionAt).toLocaleString() : "—"}</div>
          </div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn btn-primary" onClick={toggleOpen} disabled={busy || !status}>
              {status?.open ? "Close questionnaire" : "Open questionnaire"}
            </button>
            <button className="btn" onClick={() => downloadSosCsv().catch((e) => setError(e.message))} disabled={busy}>
              ⬇ Export CSV
            </button>
            <button className="btn" style={{ color: "#f87171" }} onClick={clearAll} disabled={busy}>
              🗑 Clear all
            </button>
          </div>
        </div>
        {status && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 14 }}>
            {Object.entries(DEPARTMENT_LABELS).map(([key, label]) => (
              <span key={key} style={{ background: "rgba(99,102,241,0.12)", borderRadius: 999, padding: "4px 12px", fontSize: 13 }}>
                {label}: <b>{status.byDepartment?.[key] || 0}</b>
              </span>
            ))}
            {(status.byTeam || []).map((team) => (
              <span key={team.teamName} style={{ background: "rgba(34,197,94,0.12)", borderRadius: 999, padding: "4px 12px", fontSize: 13 }}>
                🚚 {team.teamName}: <b>{team.count}</b>
              </span>
            ))}
          </div>
        )}
      </div>

      <SosSubmissionsTable
        rows={rows}
        filters={filters}
        onFiltersChange={applyFilters}
        onOpenDetail={openDetail}
        onDelete={removeSubmission}
        departmentLabels={DEPARTMENT_LABELS}
        busy={busy}
      />

      {detail && (
        <SosSubmissionDetail
          detail={detail}
          departmentLabels={DEPARTMENT_LABELS}
          onClose={() => setDetail(null)}
          onDelete={removeSubmission}
        />
      )}
    </div>
  );
}
