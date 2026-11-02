import React, { useEffect, useMemo, useState } from "react";
import * as api from "../api";
import { driverTypeLabel } from "./homeTimeViewModel";
import { CATEGORY_META, COMMITMENT_META, pctLabel } from "./homeTime/efficiencyShared";
import CompanyEfficiencyCard from "./homeTime/CompanyEfficiencyCard";

const DRIVER_TYPE_FILTERS = [
  { value: "all", label: "All driver types" },
  { value: "company_driver", label: "Company drivers" },
  { value: "lease", label: "Lease drivers" },
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

function unitSort(value) {
  if (value == null) return Number.POSITIVE_INFINITY;
  const digits = String(value).match(/\d+/);
  return digits ? Number.parseInt(digits[0], 10) : Number.POSITIVE_INFINITY;
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
      <CompanyEfficiencyCard company={company} range={range} setRange={setRange} donutSegments={donutSegments} />

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
                      <td colSpan={10} style={{ background: "var(--neutral-soft)" }}>
                        <div style={{ padding: "6px 4px" }}>
                          <div style={{ marginBottom: 8, fontSize: 13, opacity: 0.8 }}>
                            {d.too_short_road} too-short-road · {d.too_long_home} too-long-home ·
                            {" "}{d.approved_exceptions} approved exception(s) · {d.incomplete} incomplete
                          </div>
                          <div style={{ marginBottom: 8, fontSize: 13, opacity: 0.8 }}>
                            Commitment: <strong>{pctLabel(d.commitment_pct)}</strong> met ·
                            {" "}{d.commitment_met} met · {d.commitment_broken} broken ·
                            {" "}{d.commitment_incomplete} awaiting · {d.commitment_none} no approved dates
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
                                  <th>Approved dates</th>
                                  <th>Approval</th>
                                  <th>Result</th>
                                  <th>Commitment</th>
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
                                      {c.promised_home_from
                                        ? `${fmtDate(c.promised_home_from)} → ${c.promised_return_to_road ? fmtDate(c.promised_return_to_road) : "?"}`
                                        : (c.requested_home_from ? `${fmtDate(c.requested_home_from)} → ${fmtDate(c.requested_return_to_road)}` : "--")}
                                    </td>
                                    <td>{c.approval_status || "--"}</td>
                                    <td style={{ color: (CATEGORY_META[c.category] || {}).color }}>
                                      {(CATEGORY_META[c.category] || {}).label || c.category}
                                      {c.reasons && c.reasons.length ? ` (${c.reasons.join(", ")})` : ""}
                                    </td>
                                    <td style={{ color: (COMMITMENT_META[c.commitment] || {}).color }}>
                                      {(COMMITMENT_META[c.commitment] || {}).label || c.commitment || "--"}
                                      {c.commitment_reasons && c.commitment_reasons.length ? ` (${c.commitment_reasons.join(", ")})` : ""}
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
