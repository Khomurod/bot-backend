import React, { useState } from "react";
import api from "../../api/trailerDepartment";
import { Card, Empty, PageHeader, Table, useLoad } from "./TrailerUi";

/** Every backend report, grouped, with plain-language labels. */
const REPORT_GROUPS = [
  ["Rentals", [
    ["active_rentals", "Currently rented"],
    ["active_agreements", "Open rentals"],
    ["overdue_returns", "Overdue returns"],
    ["amendments", "Rental changes"],
  ]],
  ["Money", [
    ["aging", "Overdue balances by age"],
    ["partial_payments", "Partly paid invoices"],
    ["missing_receipts", "Payments without a receipt"],
    ["company_credits", "Company credits"],
    ["overpayments", "Extra payments"],
  ]],
  ["Trailers", [
    ["missing_inspections", "Missing inspections"],
    ["missing_pickup_photos", "Missing pickup photos"],
    ["unmatched_mentions", "Unknown trailer messages"],
    ["pending_master_review", "Trailers pending review"],
    ["archived_trailers", "Archived trailers"],
  ]],
];

const KPI = [
  ["Total active trailers", (d) => d?.assets?.total_active],
  ["Available", (d) => d?.assets?.available],
  ["Rented", (d) => d?.assets?.rented],
  ["Utilization", (d) => (d?.utilization_percent != null ? `${Number(d.utilization_percent).toFixed(1)}%` : "—")],
  ["Invoiced this period", (d) => (d?.finance?.invoiced != null ? `$${Number(d.finance.invoiced).toFixed(2)}` : "—")],
  ["Collected", (d) => (d?.finance?.collected != null ? `$${Number(d.finance.collected).toFixed(2)}` : "—")],
  ["Outstanding", (d) => (d?.finance?.outstanding != null ? `$${Number(d.finance.outstanding).toFixed(2)}` : "—")],
  ["Overdue balance", (d) => (d?.finance?.overdue != null ? `$${Number(d.finance.overdue).toFixed(2)}` : "—")],
];

export default function TrailerReportsPage() {
  const dashboard = useLoad(() => api.dashboard().then((r) => r.dashboard), []);
  const [name, setName] = useState("");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const choose = async (next) => {
    setName(next);
    setLoading(true);
    setError("");
    try {
      setRows((await api.report(next)).rows || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const columns = Object.keys(rows[0] || {}).map((key) => ({ key, label: key.replaceAll("_", " ") }));
  const label = REPORT_GROUPS.flatMap(([, r]) => r).find(([k]) => k === name)?.[1];

  return (
    <div>
      <PageHeader
        title="Reports"
        subtitle="Key numbers and downloadable lists across rentals, money and trailers."
        actions={name && (
          <button type="button" className="btn btn-secondary"
            onClick={() => api.downloadReport(name).catch((e) => setError(e.message))}>
            Download CSV
          </button>
        )}
      />
      <div className="trailer-metric-grid">
        {KPI.map(([kpiLabel, pick]) => (
          <Card key={kpiLabel}>
            <span>{kpiLabel}</span>
            <strong>{pick(dashboard.data) ?? "—"}</strong>
          </Card>
        ))}
      </div>
      {REPORT_GROUPS.map(([group, reports]) => (
        <div key={group}>
          <h3>{group}</h3>
          <div className="trailer-report-tabs">
            {reports.map(([key, reportLabel]) => (
              <button key={key} type="button" className={name === key ? "active" : ""}
                onClick={() => choose(key)}>
                {reportLabel}
              </button>
            ))}
          </div>
        </div>
      ))}
      {error && <div className="alert alert-danger">{error}</div>}
      <Card>
        {loading ? (
          <div className="loading"><div className="spinner" />Loading…</div>
        ) : !name ? (
          <Empty>Choose a report above to see its current results.</Empty>
        ) : rows.length ? (
          <>
            <h3>{label}</h3>
            <Table rows={rows} columns={columns} />
          </>
        ) : (
          <Empty>“{label}” has no rows right now — that usually means everything is in order.</Empty>
        )}
      </Card>
    </div>
  );
}
