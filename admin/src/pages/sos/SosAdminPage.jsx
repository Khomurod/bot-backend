/**
 * Admin — QBQ / SOS assessment section (full administrators only; the server
 * enforces admin.full_access on every /api/sos/admin endpoint).
 *
 * REAL and TEST data are managed side by side but never mixed: separate
 * status cards and open/close switches per mode, a mode filter on the
 * submissions list (real / test / combined), mode-labeled CSV exports, and
 * SEPARATE clear operations — clearing test data can never touch real
 * submissions (enforced server-side by distinct endpoints and phrases).
 */
import { useEffect, useState } from "react";
import {
  getSosAdminStatus, setSosOpen, listSosSubmissions, getSosSubmissionDetail,
  deleteSosSubmission, clearSosTestData, clearSosRealData, downloadSosCsv,
} from "../../api/sos";
import SosSubmissionsTable from "./SosSubmissionsTable";
import SosSubmissionDetail from "./SosSubmissionDetail";

const DEPARTMENT_LABELS = {
  hr: "HR / Recruiting", safety: "Safety", dispatch: "Dispatch", trailer: "Trailer",
  samsara: "Samsara Monitoring", accounting: "Accounting", updaters: "Updaters",
};

function ModeStatusCard({ title, color, stats, open, busy, onToggle }) {
  return (
    <div className="card" style={{ flex: 1, minWidth: 320, borderTop: `3px solid ${color}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <b style={{ fontSize: 15 }}>{title}</b>
        <span style={{ fontWeight: 700, color: open ? "#22c55e" : "#f87171" }}>
          {open ? "● Open" : "● Closed"}
        </span>
        <span>Completed: <b>{stats?.total ?? "…"}</b></span>
        <span style={{ fontSize: 13, opacity: 0.7 }}>
          Last: {stats?.lastSubmissionAt ? new Date(stats.lastSubmissionAt).toLocaleString() : "—"}
        </span>
        <button className="btn" style={{ marginLeft: "auto" }} onClick={onToggle} disabled={busy}>
          {open ? "Close" : "Open"}
        </button>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
        {Object.entries(DEPARTMENT_LABELS).map(([key, label]) => (
          <span key={key} style={{ background: "rgba(99,102,241,0.12)", borderRadius: 999, padding: "3px 10px", fontSize: 12.5 }}>
            {label}: <b>{stats?.byDepartment?.[key] || 0}</b>
          </span>
        ))}
        {(stats?.byTeam || []).map((team) => (
          <span key={team.teamName} style={{ background: "rgba(34,197,94,0.12)", borderRadius: 999, padding: "3px 10px", fontSize: 12.5 }}>
            🚚 {team.teamName}: <b>{team.count}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

export default function SosAdminPage() {
  const [status, setStatus] = useState(null);
  const [rows, setRows] = useState([]);
  const [filters, setFilters] = useState({ mode: "real", department: "", pattern: "", search: "" });
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

  async function toggleOpen(mode) {
    if (!status) return;
    setBusy(true);
    try {
      const current = mode === "test" ? status.testOpen : status.open;
      await setSosOpen(!current, mode);
      await loadStatus();
      setNotice(`${mode === "test" ? "TEST" : "REAL"} questionnaire ${current ? "closed" : "reopened"}.`);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function openDetail(id) {
    setBusy(true);
    try { setDetail(await getSosSubmissionDetail(id)); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function removeSubmission(id, isTest) {
    const label = isTest ? "TEST" : "REAL";
    if (!window.confirm(`Delete ${label} submission #${id}? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await deleteSosSubmission(id);
      setDetail(null);
      setNotice(`${label} submission #${id} deleted.`);
      await Promise.all([loadStatus(), loadRows()]);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function clearTest() {
    if (!window.confirm("Delete ALL TEST submissions? Real data will not be touched.")) return;
    setBusy(true);
    try {
      const res = await clearSosTestData();
      setDetail(null);
      setNotice(`Cleared ${res.deleted} TEST submission(s). Real data untouched.`);
      await Promise.all([loadStatus(), loadRows()]);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function clearReal() {
    const phrase = window.prompt(
      'DANGER: this deletes EVERY REAL submission (use only to reset before the real event).\nType DELETE ALL REAL SUBMISSIONS to confirm:',
    );
    if (phrase !== "DELETE ALL REAL SUBMISSIONS") return;
    setBusy(true);
    try {
      const res = await clearSosRealData();
      setDetail(null);
      setNotice(`Cleared ${res.deleted} REAL submission(s).`);
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

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 14 }}>
        <ModeStatusCard
          title="REAL event"
          color="#22c55e"
          stats={status?.real}
          open={Boolean(status?.open)}
          busy={busy || !status}
          onToggle={() => toggleOpen("real")}
        />
        <ModeStatusCard
          title="🧪 TEST mode"
          color="#7c3aed"
          stats={status?.test}
          open={Boolean(status?.testOpen)}
          busy={busy || !status}
          onToggle={() => toggleOpen("test")}
        />
      </div>

      <div className="card" style={{ marginBottom: 16, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: 13, opacity: 0.7 }}>Exports and cleanup:</span>
        <button className="btn" onClick={() => downloadSosCsv(filters.mode).catch((e) => setError(e.message))} disabled={busy}>
          ⬇ Export CSV ({filters.mode})
        </button>
        <button className="btn" style={{ color: "#a78bfa" }} onClick={clearTest} disabled={busy}>
          🧹 Clear TEST data
        </button>
        <button className="btn" style={{ color: "#f87171", marginLeft: "auto" }} onClick={clearReal} disabled={busy}>
          🗑 Clear REAL data…
        </button>
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
