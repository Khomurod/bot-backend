import React from "react";
import { STATUS_FILTERS, driverTypeLabel } from "../homeTimeViewModel";
import {
  fmtDate, money, nextHomeLabel, currentCycleLabel, bonusProgressLabel, sortArrow,
} from "./labels";

/**
 * The driver table: a summary strip, filters and search, every column
 * sortable, and the unlinked-activity list.
 *
 * Unlinked activity is shown rather than dropped: a request or trip whose
 * driver group no longer resolves is a data problem an admin has to see, and
 * hiding it is how a driver quietly stops being tracked.
 *
 * A row opens the detail popup; the table itself performs no writes.
 *
 * Split out of admin/src/pages/HomeTimePage.jsx.
 */
export function DriverListCard(p) {
  const {
    onRoad, atHome, overLimit, inactiveCount, companyCount, ownerCount,
    filteredStatuses, unlinkedActivity, selectedFilterLabel,
    statusFilter, setStatusFilter, driverQuery, setDriverQuery,
    sortKey, sortDirection, toggleSort, openDriverDetails,
  } = p;

  /**
   * A sortable column header. Rendered here rather than handed down from the
   * data hook: the hook owns the sort STATE, this component owns the markup.
   */
  const renderSortHeader = (label, columnKey) => {
    const active = sortKey === columnKey;
    return (
      <button
        type="button"
        className={`home-time-sort-button${active ? " active" : ""}`}
        onClick={() => toggleSort(columnKey)}
      >
        <span>{label}</span>
        <span className="home-time-sort-arrow">{sortArrow(active, sortDirection)}</span>
      </button>
    );
  };

  return (

  <div className="card" style={{ marginBottom: 20 }}>
    <div className="home-time-section-head">
      <div>
        <h3>Driver list</h3>
        <p>
          Truck number comes first, every main column sorts, and the detailed editor opens only when you need it.
        </p>
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
          placeholder="Name, truck, type"
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
      {selectedFilterLabel}. Click a row to open the popup.
    </p>

    <div className="table-container">
      <table className="table">
        <thead>
          <tr>
            <th>{renderSortHeader("Truck #", "unit_number")}</th>
            <th>{renderSortHeader("Driver", "driver_name")}</th>
            <th>{renderSortHeader("Type", "driver_type")}</th>
            <th>{renderSortHeader("Status", "state")}</th>
            <th>{renderSortHeader("Days", "current_cycle_days")}</th>
            <th>{renderSortHeader("Since", "state_since")}</th>
            <th>{renderSortHeader("Next home time", "next_home_time_date")}</th>
            <th>{renderSortHeader("Requests", "requests_count")}</th>
            <th>{renderSortHeader("Trips", "completed_trips_count")}</th>
            <th>{renderSortHeader("Bonus now", "pending_bonus_usd")}</th>
            <th>{renderSortHeader("Lifetime bonus", "lifetime_bonus_usd")}</th>
          </tr>
        </thead>
        <tbody>
          {filteredStatuses.map((driver) => {
            const isSelected = Number(driver.group_id) === Number(selectedGroupId);
            return (
              <tr
                key={driver.group_id}
                className={isSelected && isDetailOpen ? "home-time-row-selected" : undefined}
                onClick={() => openDriverDetails(driver.group_id)}
                style={{
                  cursor: "pointer",
                  opacity: driver.inactive ? 0.7 : 1,
                }}
              >
                <td>
                  <div className="home-time-driver-name">{driver.unit_number || "--"}</div>
                  <div className="home-time-subtext">{driver.inactive ? "Inactive group" : "Open details"}</div>
                </td>
                <td>
                  <div className="home-time-driver-name">{driver.driver_name}</div>
                  <div className="home-time-subtext">
                    {driver.duplicate_conflict
                      ? "Duplicate active groups need review"
                      : (isSelected ? "Selected" : "Click row to inspect")}
                  </div>
                </td>
                <td>{driverTypeLabel(driver.driver_type)}</td>
                <td>
                  <span className={`badge ${driver.state === "road" && !driver.inactive ? "" : "badge-muted"}`}>
                    {driver.state === "road" ? "On the road" : "At home"}
                  </span>
                </td>
                <td>
                  <div>{currentCycleLabel(driver)}</div>
                  <div className="home-time-subtext">{bonusProgressLabel(driver)}</div>
                </td>
                <td>{fmtDate(driver.state_since)}</td>
                <td>{nextHomeLabel(driver)}</td>
                <td>
                  <div>{driver.requests_count}</div>
                  <div className="home-time-subtext">{driver.pending_requests_count} pending</div>
                </td>
                <td>{driver.completed_trips_count}</td>
                <td>{driver.state === "road" ? money(driver.pending_bonus_usd) : "--"}</td>
                <td>{isCompanyDriver(driver.driver_type) ? money(driver.lifetime_bonus_usd) : "N/A"}</td>
              </tr>
            );
          })}
          {filteredStatuses.length === 0 && (
            <tr>
              <td colSpan={11} className="home-time-empty-cell">
                No drivers match this filter.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  </div>
  );
}
