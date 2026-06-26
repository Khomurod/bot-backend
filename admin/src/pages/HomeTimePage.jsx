import React, { useEffect, useState } from "react";
import * as api from "../api";
import {
  STATUS_FILTERS,
  buildDriverTimeline,
  buildHomeTimeViewModel,
  driverTypeLabel,
  isCompanyDriver,
} from "./homeTimeViewModel";

function fmtDate(iso) {
  if (!iso) return "--";
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

function toDateInput(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
    return d.toISOString().slice(0, 10);
  } catch {
    return String(iso).slice(0, 10);
  }
}

function money(value) {
  return `$${Number(value || 0).toFixed(0)}`;
}

function requestStatusMeta(status) {
  switch (status) {
    case "approved":
      return { label: "Approved", color: "#22c55e", background: "rgba(34, 197, 94, 0.14)" };
    case "denied":
      return { label: "Denied", color: "#ef4444", background: "rgba(239, 68, 68, 0.14)" };
    case "cancelled":
      return { label: "Cancelled", color: "#94a3b8", background: "rgba(148, 163, 184, 0.14)" };
    default:
      return { label: "Pending", color: "#f59e0b", background: "rgba(245, 158, 11, 0.14)" };
  }
}

function policyLabel(driverType, policyMet) {
  if (!isCompanyDriver(driverType)) return "N/A for owner operator";
  if (policyMet === true) return "Policy met";
  if (policyMet === false) return "Policy short";
  return "Policy not evaluated";
}

function nextHomeLabel(status) {
  if (!status) return "--";
  if (status.state === "home") return "Already home";
  if (!isCompanyDriver(status.driver_type)) return "N/A for owner operator";
  if (!status.next_home_time_date) return "--";
  return `${fmtDate(status.next_home_time_date)}${status.over_limit ? " (eligible now)" : ""}`;
}

function currentCycleLabel(status) {
  if (!status) return "--";
  return status.state === "road"
    ? `${status.days_on_road}d on road`
    : `${status.days_home}d at home`;
}

function bonusProgressLabel(status) {
  if (!status || status.state !== "road") return "No active road cycle";
  if (!isCompanyDriver(status.driver_type)) return "Owner operator - no company bonus";
  if (!status.over_limit) return "Within company road allowance";
  return `${status.pending_exceeded_weeks} extra week(s) building ${money(status.pending_bonus_usd)}`;
}

function activityTitle(item) {
  if (item.kind === "request") {
    return `${requestStatusMeta(item.status).label} home-time request`;
  }
  return "Completed road cycle";
}

export default function HomeTimePage() {
  const [settings, setSettings] = useState(null);
  const [statuses, setStatuses] = useState([]);
  const [history, setHistory] = useState([]);
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null);
  const [statusFilter, setStatusFilter] = useState("active");
  const [driverQuery, setDriverQuery] = useState("");
  const [selectedGroupId, setSelectedGroupId] = useState(null);
  const [stateSinceDraft, setStateSinceDraft] = useState("");
  const [tripDrafts, setTripDrafts] = useState({});
  const [reg, setReg] = useState({
    group_id: "",
    home_from: "",
    home_to: "",
    status: "approved",
    note: "",
  });
  const [importFiles, setImportFiles] = useState([]);
  const [importRows, setImportRows] = useState(null);
  const [importing, setImporting] = useState(false);
  const [applyingImport, setApplyingImport] = useState(false);

  const flash = (type, text) => setStatus({ type, text });

  const load = async () => {
    try {
      const [res, reqRes] = await Promise.all([
        api.getHomeTimeOverview(),
        api.getHomeTimeRequests().catch(() => ({ requests: [] })),
      ]);
      setSettings(res.settings);
      setStatuses(res.statuses || []);
      setHistory(res.history || []);
      setRequests(reqRes.requests || []);
    } catch (err) {
      flash("error", err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const saveSettings = async (patch) => {
    setSaving(true);
    setStatus(null);
    try {
      const res = await api.updateHomeTimeSettings(patch);
      setSettings(res.settings);
      flash("success", "Settings saved.");
    } catch (err) {
      flash("error", err.message);
    } finally {
      setSaving(false);
    }
  };

  const saveStatusSince = async (groupId, dateStr) => {
    setStatus(null);
    try {
      await api.updateHomeTimeStatusSince(groupId, dateStr);
      flash("success", "Start date updated.");
      await load();
    } catch (err) {
      flash("error", err.message);
    }
  };

  const saveTrip = async (id, road, home) => {
    setStatus(null);
    try {
      await api.updateHomeTimeTrip(id, {
        road_started_at: road,
        home_arrived_at: home,
      });
      flash("success", "Trip dates updated.");
      await load();
    } catch (err) {
      flash("error", err.message);
    }
  };

  const removeTrip = async (id) => {
    if (!window.confirm("Delete this completed trip record?")) return;
    setStatus(null);
    try {
      await api.deleteHomeTimeTrip(id);
      flash("success", "Trip deleted.");
      await load();
    } catch (err) {
      flash("error", err.message);
    }
  };

  const registerRequest = async (e) => {
    e.preventDefault();
    if (!selectedStatus) {
      flash("error", "Select a driver first.");
      return;
    }
    setStatus(null);
    try {
      await api.createHomeTimeRequest({
        group_id: selectedStatus.group_id,
        home_from: reg.home_from,
        home_to: reg.home_to,
        status: reg.status,
        note: reg.note || null,
      });
      flash("success", "Home-time request registered.");
      setReg((current) => ({
        ...current,
        group_id: String(selectedStatus.group_id),
        home_from: "",
        home_to: "",
        status: "approved",
        note: "",
      }));
      await load();
    } catch (err) {
      flash("error", err.message);
    }
  };

  const readScreenshots = async () => {
    if (!importFiles.length) {
      flash("error", "Choose one or more screenshots first.");
      return;
    }
    setImporting(true);
    setStatus(null);
    setImportRows(null);
    try {
      const res = await api.importHomeTimeScreenshots(importFiles);
      const rows = (res.rows || []).map((row) => ({ ...row, _include: row.matched }));
      setImportRows(rows);
      flash(
        "success",
        `Read ${res.total} drivers - ${res.matched} matched to groups, ${res.unmatched} unmatched.`
      );
    } catch (err) {
      flash("error", err.message);
    } finally {
      setImporting(false);
    }
  };

  const applyImport = async () => {
    const rows = (importRows || []).filter((row) => row._include && row.group_id);
    if (!rows.length) {
      flash("error", "No matched rows are selected to apply.");
      return;
    }
    setApplyingImport(true);
    setStatus(null);
    try {
      const report = await api.applyHomeTimeImport(rows);
      flash(
        "success",
        `Applied: ${report.statusesUpdated} statuses set, ${report.historyAdded} home-times added${
          report.historySkipped ? `, ${report.historySkipped} duplicates skipped` : ""
        }.`
      );
      setImportRows(null);
      setImportFiles([]);
      await load();
    } catch (err) {
      flash("error", err.message);
    } finally {
      setApplyingImport(false);
    }
  };

  const viewModel = buildHomeTimeViewModel({
    statuses,
    history,
    requests,
    statusFilter,
    searchQuery: driverQuery,
  });

  const {
    onRoad,
    atHome,
    overLimit,
    inactiveCount,
    companyCount,
    ownerCount,
    filteredStatuses,
    requestsByGroupId,
    historyByGroupId,
    unlinkedActivity,
  } = viewModel;

  useEffect(() => {
    if (!filteredStatuses.length) {
      setSelectedGroupId(null);
      return;
    }
    const hasSelection = filteredStatuses.some((row) => Number(row.group_id) === Number(selectedGroupId));
    if (!hasSelection) setSelectedGroupId(filteredStatuses[0].group_id);
  }, [filteredStatuses, selectedGroupId]);

  const selectedStatus = filteredStatuses.find((row) => Number(row.group_id) === Number(selectedGroupId)) || null;
  const selectedRequests = selectedStatus ? (requestsByGroupId.get(Number(selectedStatus.group_id)) || []) : [];
  const selectedHistory = selectedStatus ? (historyByGroupId.get(Number(selectedStatus.group_id)) || []) : [];
  const selectedTimeline = buildDriverTimeline({
    requests: selectedRequests,
    history: selectedHistory,
  });
  const selectedLifetimeBonus = selectedHistory.reduce((sum, row) => sum + Number(row.bonus_usd || 0), 0);
  const selectedPendingRequests = selectedRequests.filter((row) => row.status === "pending").length;
  const selectedFilterLabel =
    STATUS_FILTERS.find((filter) => filter.value === statusFilter)?.label || "All active drivers";

  useEffect(() => {
    if (!selectedStatus) {
      setStateSinceDraft("");
      return;
    }
    setStateSinceDraft(toDateInput(selectedStatus.state_since));
    setTripDrafts({});
    setReg((current) => ({
      ...current,
      group_id: String(selectedStatus.group_id),
    }));
  }, [selectedStatus]);

  const updateTripDraft = (tripId, field, value) => {
    setTripDrafts((current) => ({
      ...current,
      [tripId]: {
        ...(current[tripId] || {}),
        [field]: value,
      },
    }));
  };

  const saveSelectedSince = async () => {
    if (!selectedStatus || !stateSinceDraft) return;
    await saveStatusSince(selectedStatus.group_id, stateSinceDraft);
  };

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner"></div>
        Loading...
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <h2>Driver Home Time</h2>
        <p>
          One driver-centered workspace for current status, next company-driver home-time eligibility, request
          tracking, and completed road-cycle history.
        </p>
      </div>

      {status && (
        <div className={`alert alert-${status.type}`} style={{ marginBottom: 16 }}>
          {status.text}
        </div>
      )}

      <div className="home-time-workspace">
        <div className="card">
          <div className="home-time-section-head">
            <div>
              <h3>Driver list</h3>
              <p>Use the list as the main control surface. Select a driver to inspect requests, history, and edit details.</p>
            </div>
          </div>

          <div className="home-time-summary-strip">
            <div className="home-time-summary-chip">
              <strong>{onRoad.length}</strong>
              <span>On the road</span>
            </div>
            <div className="home-time-summary-chip">
              <strong>{atHome.length}</strong>
              <span>At home</span>
            </div>
            <div className="home-time-summary-chip">
              <strong>{companyCount}</strong>
              <span>Company drivers</span>
            </div>
            <div className="home-time-summary-chip">
              <strong>{ownerCount}</strong>
              <span>Owner operators</span>
            </div>
            <div
              className="home-time-summary-chip"
              style={overLimit.length ? { borderColor: "rgba(239, 68, 68, 0.45)" } : undefined}
            >
              <strong>{overLimit.length}</strong>
              <span>Over limit</span>
            </div>
            {inactiveCount > 0 && (
              <div className="home-time-summary-chip">
                <strong>{inactiveCount}</strong>
                <span>Inactive</span>
              </div>
            )}
          </div>

          <div className="home-time-toolbar">
            <div className="form-group" style={{ marginBottom: 0, minWidth: 220, flex: 1 }}>
              <label>Search driver</label>
              <input
                className="form-input"
                type="text"
                value={driverQuery}
                onChange={(e) => setDriverQuery(e.target.value)}
                placeholder="Name, unit, type"
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0, minWidth: 260 }}>
              <label>Filter drivers</label>
              <select className="form-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                {STATUS_FILTERS.map((filter) => (
                  <option key={filter.value} value={filter.value}>
                    {filter.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <p className="home-time-muted">
            Showing <strong>{filteredStatuses.length}</strong> driver{filteredStatuses.length === 1 ? "" : "s"}:{" "}
            {selectedFilterLabel}
          </p>

          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>Driver</th>
                  <th>Status</th>
                  <th>Current cycle</th>
                  <th>Next home time</th>
                  <th>Activity</th>
                  <th>Lifetime bonus</th>
                </tr>
              </thead>
              <tbody>
                {filteredStatuses.map((driver) => {
                  const driverRequests = requestsByGroupId.get(Number(driver.group_id)) || [];
                  const driverHistory = historyByGroupId.get(Number(driver.group_id)) || [];
                  const lifetimeBonus = driverHistory.reduce(
                    (sum, row) => sum + Number(row.bonus_usd || 0),
                    0
                  );
                  const isSelected = Number(driver.group_id) === Number(selectedGroupId);
                  return (
                    <tr
                      key={driver.group_id}
                      className={isSelected ? "home-time-row-selected" : undefined}
                      onClick={() => setSelectedGroupId(driver.group_id)}
                      style={{
                        cursor: "pointer",
                        opacity: driver.inactive ? 0.7 : 1,
                      }}
                    >
                      <td>
                        <div className="home-time-driver-name">{driver.driver_name}</div>
                        <div className="home-time-subtext">
                          {driverTypeLabel(driver.driver_type)}
                          {driver.unit_number ? ` | Unit ${driver.unit_number}` : ""}
                          {driver.inactive ? " | Inactive" : ""}
                        </div>
                      </td>
                      <td>
                        <span className={`badge ${driver.state === "road" && !driver.inactive ? "" : "badge-muted"}`}>
                          {driver.state === "road" ? "On the road" : "At home"}
                        </span>
                      </td>
                      <td>
                        <div>{currentCycleLabel(driver)}</div>
                        <div className="home-time-subtext">{fmtDate(driver.state_since)} since</div>
                      </td>
                      <td>
                        <div>{nextHomeLabel(driver)}</div>
                        <div className="home-time-subtext">{bonusProgressLabel(driver)}</div>
                      </td>
                      <td>
                        <div>{driverRequests.length} request(s)</div>
                        <div className="home-time-subtext">{driverHistory.length} completed trip(s)</div>
                      </td>
                      <td>{isCompanyDriver(driver.driver_type) ? money(lifetimeBonus) : "N/A"}</td>
                    </tr>
                  );
                })}
                {filteredStatuses.length === 0 && (
                  <tr>
                    <td colSpan={6} className="home-time-empty-cell">
                      No drivers match this filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card home-time-detail-card">
          {selectedStatus ? (
            <>
              <div className="home-time-detail-header">
                <div>
                  <h3>{selectedStatus.driver_name}</h3>
                  <p>
                    {driverTypeLabel(selectedStatus.driver_type)}
                    {selectedStatus.unit_number ? ` | Unit ${selectedStatus.unit_number}` : ""}
                  </p>
                </div>
                <div className="home-time-detail-badges">
                  <span className={`badge ${selectedStatus.state === "road" ? "" : "badge-muted"}`}>
                    {selectedStatus.state === "road" ? "On the road" : "At home"}
                  </span>
                  {selectedStatus.inactive && <span className="badge badge-muted">Inactive</span>}
                </div>
              </div>

              <div className="home-time-metrics">
                <div className="home-time-metric">
                  <span>Current cycle</span>
                  <strong>{currentCycleLabel(selectedStatus)}</strong>
                </div>
                <div className="home-time-metric">
                  <span>State since</span>
                  <strong>{fmtDate(selectedStatus.state_since)}</strong>
                </div>
                <div className="home-time-metric">
                  <span>Next home time</span>
                  <strong>{nextHomeLabel(selectedStatus)}</strong>
                </div>
                <div className="home-time-metric">
                  <span>Requests</span>
                  <strong>{selectedRequests.length}</strong>
                  <small>{selectedPendingRequests} pending</small>
                </div>
                <div className="home-time-metric">
                  <span>Completed trips</span>
                  <strong>{selectedHistory.length}</strong>
                </div>
                <div className="home-time-metric">
                  <span>Lifetime bonus</span>
                  <strong>{isCompanyDriver(selectedStatus.driver_type) ? money(selectedLifetimeBonus) : "N/A"}</strong>
                </div>
              </div>

              <div className="home-time-section">
                <div className="home-time-section-head">
                  <div>
                    <h4>Current status</h4>
                    <p>Edit the date that started the current road or home cycle. Counters recalculate from this date.</p>
                  </div>
                </div>
                <div className="home-time-form-grid">
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label>Current state</label>
                    <div className="home-time-readonly">{selectedStatus.state === "road" ? "On the road" : "At home"}</div>
                  </div>
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label>Since</label>
                    <input
                      className="form-input"
                      type="date"
                      value={stateSinceDraft}
                      max={new Date().toISOString().slice(0, 10)}
                      onChange={(e) => setStateSinceDraft(e.target.value)}
                    />
                  </div>
                  <div className="form-group" style={{ marginBottom: 0, alignSelf: "end" }}>
                    <button
                      className="btn btn-primary"
                      type="button"
                      onClick={saveSelectedSince}
                      disabled={!stateSinceDraft || stateSinceDraft === toDateInput(selectedStatus.state_since)}
                    >
                      Save date
                    </button>
                  </div>
                </div>
                <p className="home-time-muted" style={{ marginTop: 12 }}>
                  {bonusProgressLabel(selectedStatus)}
                </p>
              </div>

              <div className="home-time-section">
                <div className="home-time-section-head">
                  <div>
                    <h4>Register home-time request</h4>
                    <p>This request will be attached to the selected driver and remain visible in the merged activity feed.</p>
                  </div>
                </div>
                <form onSubmit={registerRequest}>
                  <div className="home-time-form-grid">
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label>Driver</label>
                      <div className="home-time-readonly">{selectedStatus.driver_name}</div>
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label>Home from</label>
                      <input
                        className="form-input"
                        type="date"
                        value={reg.home_from}
                        onChange={(e) => setReg((current) => ({ ...current, home_from: e.target.value }))}
                        required
                      />
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label>Home to</label>
                      <input
                        className="form-input"
                        type="date"
                        value={reg.home_to}
                        onChange={(e) => setReg((current) => ({ ...current, home_to: e.target.value }))}
                        required
                      />
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label>Status</label>
                      <select
                        className="form-select"
                        value={reg.status}
                        onChange={(e) => setReg((current) => ({ ...current, status: e.target.value }))}
                      >
                        <option value="approved">Approved</option>
                        <option value="denied">Denied</option>
                        <option value="pending">Pending</option>
                      </select>
                    </div>
                  </div>
                  <div className="form-group" style={{ marginTop: 12, marginBottom: 12 }}>
                    <label>Note</label>
                    <textarea
                      className="form-textarea"
                      value={reg.note}
                      onChange={(e) => setReg((current) => ({ ...current, note: e.target.value }))}
                      placeholder="Reason, dispatcher note, or manual context"
                    />
                  </div>
                  <button className="btn btn-primary" type="submit">
                    Register request
                  </button>
                </form>
              </div>

              <div className="home-time-section">
                <div className="home-time-section-head">
                  <div>
                    <h4>Driver activity</h4>
                    <p>Requests and completed trips are merged into one timeline so the full home-time story stays in one place.</p>
                  </div>
                </div>
                {selectedTimeline.length > 0 ? (
                  <div className="home-time-activity-list">
                    {selectedTimeline.map((item) => {
                      const requestMeta = item.kind === "request" ? requestStatusMeta(item.status) : null;
                      return (
                        <div key={item.id} className="home-time-activity-item">
                          <div className="home-time-activity-top">
                            <div>
                              <strong>{activityTitle(item)}</strong>
                              <div className="home-time-subtext">{fmtDate(item.timestamp)}</div>
                            </div>
                            {item.kind === "request" ? (
                              <span
                                className="home-time-status-pill"
                                style={{
                                  color: requestMeta.color,
                                  background: requestMeta.background,
                                }}
                              >
                                {requestMeta.label}
                              </span>
                            ) : (
                              <span className="home-time-status-pill">Trip</span>
                            )}
                          </div>

                          {item.kind === "request" ? (
                            <div className="home-time-activity-meta">
                              <span>Window: {fmtDate(item.home_from)} to {fmtDate(item.home_to)}</span>
                              <span>{policyLabel(selectedStatus.driver_type, item.policy_met)}</span>
                              <span>Days out: {item.days_on_road != null ? `${item.days_on_road}d` : "--"}</span>
                              <span>Source: {item.source || "--"}</span>
                              <span>Decided by: {item.decided_by_username ? `@${item.decided_by_username}` : "--"}</span>
                            </div>
                          ) : (
                            <div className="home-time-activity-meta">
                              <span>Road: {fmtDate(item.road_started_at)} to {fmtDate(item.home_arrived_at)}</span>
                              <span>Days out: {item.days_on_road != null ? `${item.days_on_road}d` : "--"}</span>
                              <span>Extra weeks: {item.exceeded_weeks ?? 0}</span>
                              <span>
                                Bonus: {isCompanyDriver(item.driver_type) ? money(item.bonus_usd) : "Owner operator - no company bonus"}
                              </span>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="home-time-empty-box">No requests or completed trips for this driver yet.</div>
                )}
              </div>

              <div className="home-time-section">
                <div className="home-time-section-head">
                  <div>
                    <h4>Completed trips</h4>
                    <p>Edit road and home dates here. Company-driver bonuses recalculate automatically on save.</p>
                  </div>
                </div>
                <div className="table-container">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Left</th>
                        <th>Home</th>
                        <th>Days out</th>
                        <th>Extra weeks</th>
                        <th>Bonus</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedHistory.map((trip) => (
                        <tr key={trip.id}>
                          <td>
                            <input
                              className="form-input"
                              type="date"
                              value={tripDrafts[trip.id]?.road ?? toDateInput(trip.road_started_at)}
                              onChange={(e) => updateTripDraft(trip.id, "road", e.target.value)}
                            />
                          </td>
                          <td>
                            <input
                              className="form-input"
                              type="date"
                              value={tripDrafts[trip.id]?.home ?? toDateInput(trip.home_arrived_at)}
                              onChange={(e) => updateTripDraft(trip.id, "home", e.target.value)}
                            />
                          </td>
                          <td>{trip.days_on_road}</td>
                          <td>{trip.exceeded_weeks}</td>
                          <td>
                            {isCompanyDriver(trip.driver_type)
                              ? money(trip.bonus_usd)
                              : "Owner operator - no company bonus"}
                          </td>
                          <td>
                            <div className="home-time-action-row">
                              <button
                                className="btn btn-sm"
                                type="button"
                                onClick={() =>
                                  saveTrip(
                                    trip.id,
                                    tripDrafts[trip.id]?.road ?? toDateInput(trip.road_started_at),
                                    tripDrafts[trip.id]?.home ?? toDateInput(trip.home_arrived_at)
                                  )
                                }
                              >
                                Save
                              </button>
                              <button
                                className="btn btn-sm btn-danger"
                                type="button"
                                onClick={() => removeTrip(trip.id)}
                              >
                                Delete
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                      {selectedHistory.length === 0 && (
                        <tr>
                          <td colSpan={6} className="home-time-empty-cell">
                            No completed trips yet.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          ) : (
            <div className="home-time-empty-box">
              Select a driver from the list to view home-time details, requests, and completed trips.
            </div>
          )}
        </div>
      </div>

      <div className="card" style={{ marginTop: 20, marginBottom: 20 }}>
        <h3>Settings</h3>
        {settings && (
          <div style={{ display: "grid", gap: 12, maxWidth: 560 }}>
            <label>
              <input
                type="checkbox"
                checked={settings.enabled}
                onChange={(e) => saveSettings({ enabled: e.target.checked })}
                disabled={saving}
              />{" "}
              Tracking enabled
            </label>
            <div className="home-time-form-grid">
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>Weeks allowed on the road</label>
                <input
                  className="form-input"
                  type="number"
                  min="1"
                  max="52"
                  defaultValue={settings.road_allowance_weeks}
                  onBlur={(e) => saveSettings({ road_allowance_weeks: Number(e.target.value) })}
                />
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>Days allowed at home</label>
                <input
                  className="form-input"
                  type="number"
                  min="1"
                  max="60"
                  defaultValue={settings.home_allowance_days}
                  onBlur={(e) => saveSettings({ home_allowance_days: Number(e.target.value) })}
                />
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>Bonus per extra week ($)</label>
                <input
                  className="form-input"
                  type="number"
                  min="0"
                  step="1"
                  defaultValue={settings.bonus_per_week}
                  onBlur={(e) => saveSettings({ bonus_per_week: Number(e.target.value) })}
                />
              </div>
            </div>
            <p className="home-time-muted" style={{ margin: 0 }}>
              Company-driver policy: at least {settings.road_allowance_weeks} weeks on the road, then{" "}
              {settings.home_allowance_days} days home. Each full extra road week earns{" "}
              {money(settings.bonus_per_week)} for company drivers only. Owner operators stay visible for tracking but
              do not accrue the company bonus.
            </p>
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <h3>Import from screenshots</h3>
        <p className="home-time-muted" style={{ marginTop: 0 }}>
          Upload spreadsheet screenshots. The app reads current status, dates, and history, then lets you review the matched rows before applying them.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            onChange={(e) => setImportFiles(Array.from(e.target.files || []))}
          />
          <button className="btn btn-primary" onClick={readScreenshots} disabled={importing || !importFiles.length}>
            {importing ? "Reading..." : "Read screenshots"}
          </button>
        </div>

        {importRows && (
          <div style={{ marginTop: 16 }}>
            <div className="table-container">
              <table className="table">
                <thead>
                  <tr>
                    <th>Use</th>
                    <th>Name from image</th>
                    <th>Matched driver</th>
                    <th>Status</th>
                    <th>Since</th>
                    <th>History</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {importRows.map((row, index) => (
                    <tr
                      key={index}
                      style={!row.matched ? { background: "rgba(239, 68, 68, 0.08)" } : undefined}
                    >
                      <td>
                        <input
                          type="checkbox"
                          checked={row._include && row.matched}
                          disabled={!row.matched}
                          onChange={(e) => {
                            const next = [...importRows];
                            next[index] = { ...next[index], _include: e.target.checked };
                            setImportRows(next);
                          }}
                        />
                      </td>
                      <td>{row.name}</td>
                      <td>{row.matched ? row.driver_label : <span style={{ color: "#ef4444" }}>No match</span>}</td>
                      <td>{row.status === "road" ? "On the road" : row.status === "home" ? "At home" : "--"}</td>
                      <td>{row.since_date || "--"}</td>
                      <td>{row.history?.length ? `${row.history.length} period(s)` : "--"}</td>
                      <td style={{ maxWidth: 220, whiteSpace: "normal" }}>{row.notes || "--"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button className="btn btn-primary" onClick={applyImport} disabled={applyingImport} style={{ marginTop: 8 }}>
              {applyingImport
                ? "Applying..."
                : `Apply ${importRows.filter((row) => row._include && row.group_id).length} matched rows`}
            </button>
          </div>
        )}
      </div>

      {unlinkedActivity.length > 0 && (
        <div className="card">
          <h3>Unlinked activity</h3>
          <p className="home-time-muted" style={{ marginTop: 0 }}>
            These requests or completed trips do not point to a currently tracked driver status, so they stay visible here instead of disappearing.
          </p>
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Driver</th>
                  <th>Date</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {unlinkedActivity.map((item) => (
                  <tr key={item.id}>
                    <td>{item.kind === "request" ? "Request" : "Trip"}</td>
                    <td>
                      <div className="home-time-driver-name">{item.driver_name}</div>
                      <div className="home-time-subtext">
                        {driverTypeLabel(item.driver_type)}
                        {item.unit_number ? ` | Unit ${item.unit_number}` : ""}
                      </div>
                    </td>
                    <td>{fmtDate(item.timestamp)}</td>
                    <td>
                      {item.kind === "request"
                        ? `${requestStatusMeta(item.status).label} | ${fmtDate(item.home_from)} to ${fmtDate(item.home_to)} | ${item.source || "--"}`
                        : `${fmtDate(item.road_started_at)} to ${fmtDate(item.home_arrived_at)} | ${money(item.bonus_usd)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
