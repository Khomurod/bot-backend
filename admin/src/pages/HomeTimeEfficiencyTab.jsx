import React, { useEffect, useMemo, useState } from "react";
import * as api from "../api";
import { driverTypeLabel } from "./homeTimeViewModel";

// Category palette — colorblind-safe and NOT relied on alone (every chart segment
// and table badge also carries a text label + count + %). Matches the request
// status colors used elsewhere on the page for consistency.
const CATEGORY_META = {
  compliant: { label: "Policy compliant", color: "#22c55e" },
  approved_exception: { label: "Approved exception", color: "#38bdf8" },
  non_compliant: { label: "Policy not followed", color: "#ef4444" },
  incomplete: { label: "Incomplete data", color: "#94a3b8" },
  not_applicable: { label: "Policy not applicable", color: "#a78bfa" },
};

const RANGES = [
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "180", label: "Last 180 days" },
  { value: "all", label: "All time" },
];

const DRIVER_TYPE_FILTERS = [
  { value: "all", label: "All driver types" },
  { value: "company_driver", label: "Company drivers" },
  { value: "owner", label: "Owner operators" },
];

const COMPLIANCE_FILTERS = [
  { value: "all", label: "All results" },
  { value: "compliant", label: "Has compliant cycles" },
  { value: "non_compliant", label: "Has violations" },
  { value: "approved_exception", label: "Has approved exceptions" },
  { value: "incomplete", label: "Has incomplete data" },
];

const SORT_COLUMNS = [
  { key: "driver_name", label: "Driver" },
  { key: "unit_number", label: "Unit" },
  { key: "completed_cycles", label: "Cycles" },
  { key: "compliant", label: "Compliant" },
  { key: "non_compliant", label: "Violations" },
  { key: "efficiency_pct", label: "Efficiency" },
  { key: "avg_road_days", label: "Avg road" },
  { key: "avg_home_days", label: "Avg home" },
];

function fmtDate(iso) {
  if (!iso) return "--";
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return String(iso).slice(0, 10);
  }
}

function pctLabel(value) {
  return value == null ? "--" : `${value}%`;
}

function unitSort(value) {
  if (value == null) return Number.POSITIVE_INFINITY;
  const digits = String(value).match(/\d+/);
  return digits ? Number.parseInt(digits[0], 10) : Number.POSITIVE_INFINITY;
}

/** Accessible donut: labelled arcs (never color-only). Falls back to an empty ring. */
function Donut({ segments, size = 168, stroke = 26 }) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  let offset = 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Cycle compliance breakdown">
      <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="rgba(148,163,184,0.18)" strokeWidth={stroke} />
        {total > 0 && segments.filter((s) => s.value > 0).map((s) => {
          const len = (s.value / total) * circumference;
          const dash = `${len} ${circumference - len}`;
          const el = (
            <circle
              key={s.key}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={s.color}
              strokeWidth={stroke}
              strokeDasharray={dash}
              strokeDashoffset={-offset}
            >
              <title>{`${s.label}: ${s.value} (${total ? Math.round((s.value / total) * 100) : 0}%)`}</title>
            </circle>
          );
          offset += len;
          return el;
        })}
      </g>
      <text x="50%" y="47%" textAnchor="middle" fontSize="26" fontWeight="700" fill="currentColor">
        {total}
      </text>
      <text x="50%" y="61%" textAnchor="middle" fontSize="11" fill="currentColor" opacity="0.7">
        cycles
      </text>
    </svg>
  );
}

export default function HomeTimeEfficiencyTab({ flash }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState("all");
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [complianceFilter, setComplianceFilter] = useState("all");
  const [sortKey, setSortKey] = useState("efficiency_pct");
  const [sortDir, setSortDir] = useState("asc");
  const [expanded, setExpanded] = useState(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .getHomeTimeEfficiency(range)
      .then((res) => { if (alive) setData(res); })
      .catch((err) => { if (alive && flash) flash("error", err.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [range]);

  const company = data?.company || null;

  const donutSegments = useMemo(() => {
    if (!company) return [];
    return ["compliant", "approved_exception", "non_compliant", "incomplete"].map((key) => ({
      key,
      label: CATEGORY_META[key].label,
      color: CATEGORY_META[key].color,
      value: Number(company[key] || 0),
    }));
  }, [company]);

  const rows = useMemo(() => {
    const list = (data?.drivers || []).filter((d) => {
      if (typeFilter !== "all" && d.driver_type !== typeFilter) return false;
      if (complianceFilter === "compliant" && !(d.compliant > 0)) return false;
      if (complianceFilter === "non_compliant" && !(d.non_compliant > 0)) return false;
      if (complianceFilter === "approved_exception" && !(d.approved_exceptions > 0)) return false;
      if (complianceFilter === "incomplete" && !(d.incomplete > 0)) return false;
      if (query.trim()) {
        const hay = [d.driver_name, d.unit_number, d.driver_type].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(query.trim().toLowerCase())) return false;
      }
      return true;
    });
    const dir = sortDir === "desc" ? -1 : 1;
    return list.sort((a, b) => {
      let av;
      let bv;
      if (sortKey === "driver_name") { av = String(a.driver_name || ""); bv = String(b.driver_name || ""); return av.localeCompare(bv) * dir; }
      if (sortKey === "unit_number") { av = unitSort(a.unit_number); bv = unitSort(b.unit_number); }
      else { av = a[sortKey] == null ? -Infinity : Number(a[sortKey]); bv = b[sortKey] == null ? -Infinity : Number(b[sortKey]); }
      if (av === bv) return String(a.driver_name || "").localeCompare(String(b.driver_name || ""));
      return (av - bv) * dir;
    });
  }, [data, typeFilter, complianceFilter, query, sortKey, sortDir]);

  const toggleSort = (key) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  };

  if (loading && !data) {
    return (
      <div className="loading">
        <div className="spinner"></div>
        Loading efficiency…
      </div>
    );
  }
  if (!company) {
    return <div className="card">No efficiency data available yet.</div>;
  }

  return (
    <div>
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="home-time-section-head">
          <div>
            <h3>Company home-time efficiency</h3>
            <p>
              How well drivers follow the policy of at least <strong>{company.road_allowance_days} days</strong> on the
              road and no more than <strong>{company.home_allowance_days} days</strong> at home, from actual completed
              cycles. Owner operators are not counted (policy not applicable).
            </p>
          </div>
          <div className="form-group" style={{ marginBottom: 0, minWidth: 180 }}>
            <label>Date range</label>
            <select className="form-select" value={range} onChange={(e) => setRange(e.target.value)}>
              {RANGES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </div>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 24, alignItems: "center", marginTop: 12 }}>
          <div style={{ display: "flex", gap: 20, alignItems: "center" }}>
            <Donut segments={donutSegments} />
            <div>
              {donutSegments.map((s) => {
                const total = company.total_completed_cycles + company.incomplete || 0;
                const share = total ? Math.round((s.value / total) * 100) : 0;
                return (
                  <div key={s.key} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <span style={{ width: 12, height: 12, borderRadius: 3, background: s.color, display: "inline-block" }} />
                    <span style={{ minWidth: 150 }}>{s.label}</span>
                    <strong>{s.value}</strong>
                    <span style={{ opacity: 0.6 }}>({share}%)</span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="home-time-summary-strip" style={{ flex: 1, minWidth: 260 }}>
            <div className="home-time-summary-chip">
              <strong>{pctLabel(company.strict_efficiency_pct)}</strong>
              <span>Strict efficiency</span>
            </div>
            <div className="home-time-summary-chip">
              <strong>{pctLabel(company.operational_efficiency_pct)}</strong>
              <span>Incl. approved exceptions</span>
            </div>
            <div className="home-time-summary-chip">
              <strong>{company.total_completed_cycles}</strong>
              <span>Cycles analyzed</span>
            </div>
            <div className="home-time-summary-chip">
              <strong>{company.total_eligible_drivers}</strong>
              <span>Eligible drivers</span>
            </div>
            <div className="home-time-summary-chip">
              <strong>{company.approved_exception}</strong>
              <span>Approved exceptions</span>
            </div>
          </div>
        </div>
        <p className="home-time-muted" style={{ marginTop: 10 }}>
          Strict efficiency = compliant cycles ÷ all policy-eligible completed cycles. Operational efficiency also credits
          approved exceptions. Incomplete cycles (home stay not yet closed) are excluded from both.
        </p>
      </div>

      <div className="card">
        <div className="home-time-section-head">
          <div>
            <h3>Driver efficiency</h3>
            <p>Click a driver to see their cycle-by-cycle detail.</p>
          </div>
        </div>

        <div className="home-time-toolbar">
          <div className="form-group" style={{ marginBottom: 0, minWidth: 200, flex: 1 }}>
            <label>Search driver</label>
            <input className="form-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name, unit, type" />
          </div>
          <div className="form-group" style={{ marginBottom: 0, minWidth: 190 }}>
            <label>Driver type</label>
            <select className="form-select" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
              {DRIVER_TYPE_FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 0, minWidth: 190 }}>
            <label>Compliance</label>
            <select className="form-select" value={complianceFilter} onChange={(e) => setComplianceFilter(e.target.value)}>
              {COMPLIANCE_FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          </div>
        </div>

        <div style={{ overflowX: "auto" }}>
          <table className="table home-time-table">
            <thead>
              <tr>
                {SORT_COLUMNS.map((c) => (
                  <th key={c.key}>
                    <button type="button" className={`home-time-sort-button${sortKey === c.key ? " active" : ""}`} onClick={() => toggleSort(c.key)}>
                      <span>{c.label}</span>
                      <span className="home-time-sort-arrow">{sortKey === c.key ? (sortDir === "asc" ? "^" : "v") : "<>"}</span>
                    </button>
                  </th>
                ))}
                <th>Latest</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <React.Fragment key={d.group_id}>
                  <tr style={{ cursor: "pointer" }} onClick={() => setExpanded(expanded === d.group_id ? null : d.group_id)}>
                    <td>
                      <strong>{d.driver_name}</strong>
                      <div style={{ fontSize: 12, opacity: 0.7 }}>{driverTypeLabel(d.driver_type)}</div>
                    </td>
                    <td>{d.unit_number || "--"}</td>
                    <td>{d.completed_cycles}</td>
                    <td style={{ color: CATEGORY_META.compliant.color }}>{d.compliant}</td>
                    <td style={{ color: d.non_compliant ? CATEGORY_META.non_compliant.color : undefined }}>{d.non_compliant}</td>
                    <td><strong>{d.policy_applies ? pctLabel(d.efficiency_pct) : "N/A"}</strong></td>
                    <td>{d.avg_road_days == null ? "--" : `${d.avg_road_days}d`}</td>
                    <td>{d.avg_home_days == null ? "--" : `${d.avg_home_days}d`}</td>
                    <td>
                      {d.latest_cycle_result ? (
                        <span style={{ color: (CATEGORY_META[d.latest_cycle_result] || {}).color }}>
                          {(CATEGORY_META[d.latest_cycle_result] || {}).label || d.latest_cycle_result}
                        </span>
                      ) : "--"}
                    </td>
                    <td>{d.current_state || "--"}</td>
                  </tr>
                  {expanded === d.group_id && (
                    <tr>
                      <td colSpan={10} style={{ background: "rgba(148,163,184,0.06)" }}>
                        <div style={{ padding: "6px 4px" }}>
                          <div style={{ marginBottom: 8, fontSize: 13, opacity: 0.8 }}>
                            {d.too_short_road} too-short-road · {d.too_long_home} too-long-home ·
                            {" "}{d.approved_exceptions} approved exception(s) · {d.incomplete} incomplete
                          </div>
                          {(!d.cycles || d.cycles.length === 0) && <div className="home-time-muted">No cycles in range.</div>}
                          {d.cycles && d.cycles.length > 0 && (
                            <table className="table" style={{ fontSize: 13 }}>
                              <thead>
                                <tr>
                                  <th>Road start</th>
                                  <th>Home arrival</th>
                                  <th>Back on road</th>
                                  <th>Road days</th>
                                  <th>Home days</th>
                                  <th>Requested</th>
                                  <th>Approval</th>
                                  <th>Result</th>
                                </tr>
                              </thead>
                              <tbody>
                                {d.cycles.map((c) => (
                                  <tr key={c.id}>
                                    <td>{fmtDate(c.road_started_at)}</td>
                                    <td>{fmtDate(c.home_arrived_at)}</td>
                                    <td>{fmtDate(c.return_to_road_at)}</td>
                                    <td>{c.road_days == null ? "--" : c.road_days}</td>
                                    <td>{c.home_days == null ? "--" : c.home_days}</td>
                                    <td>
                                      {c.requested_home_from
                                        ? `${fmtDate(c.requested_home_from)} → ${fmtDate(c.requested_return_to_road)}`
                                        : "--"}
                                    </td>
                                    <td>{c.approval_status || "--"}</td>
                                    <td style={{ color: (CATEGORY_META[c.category] || {}).color }}>
                                      {(CATEGORY_META[c.category] || {}).label || c.category}
                                      {c.reasons && c.reasons.length ? ` (${c.reasons.join(", ")})` : ""}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={10} className="home-time-empty-cell">No drivers match the current filters.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
