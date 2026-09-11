import React from "react";
import HomeTimeRequestDatesEditor from "../HomeTimeRequestDatesEditor";
import RetiredApprovalNote from "./RetiredApprovalNote";
import { driverTypeLabel, isCompanyDriver } from "../homeTimeViewModel";
import {
  fmtDate, toDateInput, money, requestStatusMeta, policyLabel,
  nextHomeLabel, currentCycleLabel, bonusProgressLabel, activityTitle,
} from "./labels";

/**
 * The per-driver popup: current state, the request timeline, completed trips,
 * and the forms that edit them.
 *
 * Changing the STATE and changing the START DATE are separate saves, because
 * they mean different things: a flipped state begins a new cycle (from the
 * edited date when one was entered, otherwise from now), while editing only
 * the date corrects when the current cycle began. Merging them would silently
 * reset a driver's clock.
 *
 * Deleting a completed trip is confirmed first — the row carries a paid bonus
 * amount.
 *
 * Split out of admin/src/pages/HomeTimePage.jsx.
 */
export function DriverDetailModal(p) {
  const {
    selectedStatus, selectedRequests, selectedHistory, selectedTimeline,
    selectedLifetimeBonus, selectedPendingRequests,
    setIsDetailOpen, stateSinceDraft, setStateSinceDraft,
    stateDraft, setStateDraft, tripDrafts, updateTripDraft, reg, setReg,
    saveSelectedState, saveSelectedSince, saveTrip, removeTrip,
    registerRequest, load, flash,
  } = p;

  // A trip with no return date is an OPEN cycle, not a completed one — 74 of 79
  // production rows. Counted rather than just relabelled, because the tile above
  // the table was telling the same untruth the table itself used to.
  const completedTripCount = selectedHistory.filter((t) => t.return_to_road_at).length;
  const openTripCount = selectedHistory.length - completedTripCount;

  return (
    <div className="home-time-modal-backdrop" onClick={() => setIsDetailOpen(false)}>
      <div className="card home-time-modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="home-time-modal-header">
          <div>
            <div className="home-time-modal-kicker">Driver home-time details</div>
            <h3>{selectedStatus.driver_name}</h3>
            <p>
              Truck {selectedStatus.unit_number || "--"} | {driverTypeLabel(selectedStatus.driver_type)}
            </p>
            {selectedStatus.duplicate_conflict && (
              <p className="home-time-muted" style={{ marginTop: 4 }}>
                Multiple active driver groups share this identity. Review Driver Groups before editing access/status assumptions.
              </p>
            )}
          </div>
          <div className="home-time-modal-actions">
            <span className={`badge ${selectedStatus.state === "road" ? "" : "badge-muted"}`}>
              {selectedStatus.state === "road" ? "On the road" : "At home"}
            </span>
            {selectedStatus.inactive && <span className="badge badge-muted">Inactive</span>}
            <button
              type="button"
              className="home-time-modal-close"
              onClick={() => setIsDetailOpen(false)}
              aria-label="Close driver details"
            >
              x
            </button>
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
            <strong>{completedTripCount}</strong>
            {openTripCount > 0 && <small>{openTripCount} still open</small>}
          </div>
          <div className="home-time-metric">
            <span>Lifetime bonus</span>
            <strong>{isCompanyDriver(selectedStatus.driver_type) ? money(selectedLifetimeBonus) : "N/A"}</strong>
          </div>
        </div>

        <div className="home-time-modal-body">
          <div className="home-time-section">
            <div className="home-time-section-head">
              <div>
                <h4>Current status</h4>
                <p>
                  Change the state (on the road / at home) or the date that started the current cycle. Counters
                  recalculate from the start date. Flipping the state without picking a new date restarts the cycle
                  from today.
                </p>
              </div>
            </div>
            <div className="home-time-form-grid">
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>Current state</label>
                <select
                  className="form-select"
                  value={stateDraft}
                  onChange={(e) => setStateDraft(e.target.value)}
                >
                  <option value="road">On the road</option>
                  <option value="home">At home</option>
                </select>
              </div>
              <div className="form-group" style={{ marginBottom: 0, alignSelf: "end" }}>
                <button
                  className="btn btn-primary"
                  type="button"
                  onClick={saveSelectedState}
                  disabled={!stateDraft || stateDraft === selectedStatus.state}
                >
                  Save state
                </button>
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
                  const requestMeta = item.kind === "request" ? requestStatusMeta(item.status, item.clarification_channel) : null;
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
                          <span>Back on the road: {fmtDate(item.return_to_road_date)}</span>
                          <span>{policyLabel(selectedStatus.driver_type, item.policy_met)}</span>
                          <span>Days out: {item.days_on_road != null ? `${item.days_on_road}d` : "--"}</span>
                          <span>Source: {item.source || "--"}</span>
                          <span>Decided by: {item.decided_by_username ? `@${item.decided_by_username}` : "--"}</span>
                          {item.decided_at ? <span>Decided: {fmtDate(item.decided_at)}</span> : null}
                          {item.note ? <span>Notes: {item.note}</span> : null}
                          <HomeTimeRequestDatesEditor
                            requestId={item.request_id}
                            homeFrom={item.home_from}
                            returnToRoad={item.return_to_road_date}
                            flash={flash}
                            onSaved={load}
                          />
                          <RetiredApprovalNote request={item} />
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
                <h4>Trips</h4>
                <p>
                  Edit road and home dates here. Company-driver bonuses recalculate
                  automatically on save. A trip with no return date is still OPEN — the
                  driver has not been recorded as back on the road.
                </p>
              </div>
            </div>
            <div className="table-container">
              <table className="table">
                <thead>
                  <tr>
                    <th>Left</th>
                    <th>Home</th>
                    <th>Back on road</th>
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
                        {trip.source_group_id != null && Number(trip.source_group_id) !== Number(trip.group_id) && (
                          <small style={{ color: "var(--text-muted)" }}>recorded on an earlier chat</small>
                        )}
                      </td>
                      <td>
                        <input
                          className="form-input"
                          type="date"
                          value={tripDrafts[trip.id]?.home ?? toDateInput(trip.home_arrived_at)}
                          onChange={(e) => updateTripDraft(trip.id, "home", e.target.value)}
                        />
                      </td>
                      {/*
                        This column is why it exists. The table used to be
                        titled "Completed trips" and render every road-history
                        row, so an OPEN cycle — 74 of 79 rows in production —
                        looked exactly like a finished one, and nothing anywhere
                        said otherwise.
                      */}
                      <td>
                        {trip.return_to_road_at ? (
                          fmtDate(trip.return_to_road_at)
                        ) : (
                          <span className="badge badge-muted" title="No return-to-road date recorded — this trip is still open.">
                            Still home
                          </span>
                        )}
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
                      <td colSpan={7} className="home-time-empty-cell">
                        No trips recorded yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
