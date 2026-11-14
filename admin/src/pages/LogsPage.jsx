import React from "react";
import * as api from "../api";
import LogRow from "./logs/LogRow";

/**
 * Monitoring → Logs (owner, 14 November 2026): every change Wenze made in
 * Bitrix — who, what and why — and every attempt that was refused or failed,
 * each its own line, newest first. docs/architecture/activity-log.md.
 *
 * SUPER ADMINISTRATORS ONLY: the sidebar shows it to them alone and the
 * server refuses anyone else. READ-ONLY: there is deliberately no retry and
 * no revert here — a fix is made where the change was made. No automatic
 * refresh: the page reads when it opens, when a filter is applied, and when
 * Refresh or "Show older" is pressed.
 */

const RESULTS = [
  { key: "", label: "Any result" },
  { key: "done", label: "Done" },
  { key: "refused", label: "Refused" },
  { key: "failed", label: "Failed" },
  { key: "already_done", label: "Already so" },
];

const EMPTY = { from: "", to: "", trigger: "", result: "", search: "" };

/** The form's local dates as the server's ISO instants; "to" includes its whole day. */
export function toQuery(form) {
  const day = (d, plus = 0) => {
    if (!d) return "";
    const t = new Date(`${d}T00:00:00`);
    t.setDate(t.getDate() + plus);
    return Number.isNaN(t.getTime()) ? "" : t.toISOString();
  };
  return {
    from: day(form.from), to: day(form.to, 1), trigger: form.trigger, result: form.result, search: form.search,
  };
}

export default function LogsPage() {
  const [form, setForm] = React.useState(EMPTY);
  const [applied, setApplied] = React.useState(EMPTY);
  const [entries, setEntries] = React.useState([]);
  const [triggers, setTriggers] = React.useState([]);
  const [cursor, setCursor] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);

  const load = React.useCallback(async (filters, before = null) => {
    setLoading(true);
    setError(null);
    try {
      const page = await api.getActivityLog({ ...toQuery(filters), before });
      setEntries((prev) => (before ? [...prev, ...(page.entries || [])] : page.entries || []));
      setCursor(page.nextCursor || null);
      if (Array.isArray(page.triggers)) setTriggers(page.triggers);
    } catch (err) {
      setError(err?.status === 403
        ? "Only a super administrator can open the Logs."
        : err?.message || "Could not load the logs.");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { load(EMPTY); }, [load]);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const apply = (e) => {
    e?.preventDefault();
    setApplied(form);
    load(form);
  };
  const clear = () => {
    setForm(EMPTY);
    setApplied(EMPTY);
    load(EMPTY);
  };
  const featureLabel = (key) => triggers.find((t) => t.key === key)?.label || key;

  return (
    <div>
      <div className="page-header">
        <h2>Logs</h2>
        <p>
          Every change Wenze made in Bitrix — who did it, what changed and why — and every write Bitrix
          refused or did not answer. A button press, a reply, the status sync or a home-time card move
          that was stopped before writing is listed too. Newest first. Entries are kept for a year; the
          driver&apos;s or candidate&apos;s name is removed after 60 days and only the deal number stays.
        </p>
      </div>

      <form className="card" onSubmit={apply} aria-label="Filter the logs"
        style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label htmlFor="logs-from">From</label>
          <input id="logs-from" type="date" className="form-input" value={form.from} onChange={set("from")} />
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label htmlFor="logs-to">To</label>
          <input id="logs-to" type="date" className="form-input" value={form.to} onChange={set("to")} />
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label htmlFor="logs-feature">Feature</label>
          <select id="logs-feature" className="form-select" value={form.trigger} onChange={set("trigger")}>
            <option value="">Every feature</option>
            {triggers.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label htmlFor="logs-result">Result</label>
          <select id="logs-result" className="form-select" value={form.result} onChange={set("result")}>
            {RESULTS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
          </select>
        </div>
        <div className="form-group" style={{ marginBottom: 0, flex: "1 1 200px" }}>
          <label htmlFor="logs-search">Deal number or name</label>
          <input id="logs-search" type="search" className="form-input" value={form.search}
            onChange={set("search")} placeholder="e.g. 4512 or Smith" maxLength={80} />
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="submit" className="btn btn-primary" disabled={loading}>Apply</button>
          <button type="button" className="btn btn-secondary" onClick={clear} disabled={loading}>Clear</button>
          <button type="button" className="btn btn-secondary" onClick={() => load(applied)} disabled={loading}>Refresh</button>
        </div>
      </form>

      {error && <div className="alert alert-error" role="alert" style={{ margin: "12px 0" }}>{error}</div>}

      <div className="card" style={{ marginTop: 12 }}>
        {!error && !loading && entries.length === 0 && (
          <p className="muted">Nothing recorded{applied === EMPTY ? " yet" : " for these filters"}.</p>
        )}
        {entries.length > 0 && (
          <div className="table-container">
            <table className="data-table" style={{ width: "100%", fontSize: 13 }}>
              <thead>
                <tr>
                  <th>When</th>
                  <th>What</th>
                  <th>Who</th>
                  <th>Why</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => <LogRow key={e.id} entry={e} featureLabel={featureLabel} />)}
              </tbody>
            </table>
          </div>
        )}
        {loading && <p className="muted">Loading…</p>}
        {!loading && cursor && (
          <button type="button" className="btn btn-secondary" style={{ marginTop: 12 }} onClick={() => load(applied, cursor)}>
            Show older
          </button>
        )}
      </div>
    </div>
  );
}
