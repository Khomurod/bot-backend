import React from "react";
import {
  isDriverActive, formatStatusSource, driverLabel, memberOptionLabel,
} from "./driverProfileShaping";

/**
 * The driver-profile table, including its loading and empty states.
 *
 * Inline cells save on blur and only when the value actually changed, so
 * tabbing across a row does not fire a write per field.
 *
 * Duplicate and needs-review flags are shown per row rather than filtered out:
 * a duplicated driver group is something an admin has to resolve, and hiding it
 * here is how Home Time ends up tracking the wrong group.
 *
 * Split out of admin/src/pages/GroupsPage.jsx.
 */
export function DriverProfilesTable({
  loading, displayProfiles, draftsById, savingProfileId,
  statusSort, toggleStatusSort, setOpenProfileId,
  updateDraft, saveProfilePatch,
}) {
  return (
    <>

{loading ? (
  <div className="loading"><div className="spinner"></div> Loading driver profiles...</div>
) : displayProfiles.length === 0 ? (
  <div className="empty-state">
    <div className="icon">👥</div>
    <h3>No driver profiles in this view</h3>
    <p>Run the backfill script and ensure the bot has joined driver groups.</p>
  </div>
) : (
  <div className="table-container">
    <table>
      <thead>
        <tr>
          <th>Group Name</th>
          <th>Driver</th>
          <th>Type</th>
          <th>
            {activeTab === "all" ? (
              <button
                type="button"
                onClick={toggleStatusSort}
                style={{
                  background: "none",
                  border: "none",
                  padding: 0,
                  font: "inherit",
                  fontWeight: 600,
                  cursor: "pointer",
                  color: "inherit",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                }}
                title="Click to sort by status"
              >
                Status
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  {statusSort === "active-first" ? "▲ Active first" : "▲ Inactive first"}
                </span>
              </button>
            ) : (
              "Status"
            )}
          </th>
          <th>Unit</th>
        </tr>
      </thead>
      <tbody>
        {displayProfiles.map((profile) => {
          const draft = draftsById[profile.id] || profileToDraft(profile);
          const saving = savingProfileId === profile.id;
          const name = driverLabel(profile);

          return (
            <tr key={profile.id}>
              <td>
                <strong>{profile.group_name || "Unknown group"}</strong>
                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  via {formatStatusSource(profile.status_source)}
                </div>
                {profile.duplicate_conflict && (
                  <div style={{ fontSize: 11, color: "#f59e0b" }}>
                    Multiple active duplicates - review required
                  </div>
                )}
                {!profile.duplicate_conflict && profile.duplicate_group_count > 1 && (
                  <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                    Linked duplicate set ({profile.duplicate_group_count} groups)
                  </div>
                )}
              </td>
              <td>
                <button
                  type="button"
                  onClick={() => setOpenProfileId(profile.id)}
                  title="Open driver details (name, birthday, language, Telegram link, review)"
                  style={{
                    background: "none",
                    border: "none",
                    padding: 0,
                    font: "inherit",
                    fontWeight: 600,
                    cursor: "pointer",
                    color: "var(--primary, #6366f1)",
                    textDecoration: "underline",
                    textAlign: "left",
                  }}
                >
                  {name || "— set driver —"}
                </button>
                {(profile.needs_review === true || profile.duplicate_review_required === true) && (
                  <div style={{ fontSize: 11, color: "#f59e0b" }}>Needs review</div>
                )}
                {profile.telegram_username ? (
                  <div style={{ fontSize: 11, color: "var(--text-muted)" }}>@{profile.telegram_username}</div>
                ) : profile.telegram_user_id ? (
                  <div style={{ fontSize: 11, color: "var(--text-muted)" }}>linked (no @username)</div>
                ) : null}
              </td>
              <td>
                <select
                  className="form-input"
                  style={{ width: "auto", padding: "4px 8px" }}
                  value={draft.driver_type}
                  disabled={saving}
                  onChange={(e) => {
                    const next = e.target.value;
                    updateDraft(profile.id, { driver_type: next });
                    if ((profile.driver_type || "owner") === next) return;
                    saveProfilePatch(profile, { driver_type: next }, "Driver type updated.");
                  }}
                >
                  <option value="owner">Owner</option>
                  <option value="company_driver">Company Driver</option>
                </select>
              </td>
              <td>
                <select
                  className="form-input"
                  style={{ width: "auto", padding: "4px 8px" }}
                  value={draft.status}
                  disabled={saving}
                  onChange={(e) => {
                    const next = e.target.value;
                    updateDraft(profile.id, { status: next });
                    if ((profile.status || "active") === next) return;
                    saveProfilePatch(profile, { status: next }, "Driver status updated.");
                  }}
                >
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </td>
              <td>
                <input
                  type="text"
                  className="form-input"
                  style={{ minWidth: 90, padding: "4px 8px" }}
                  value={draft.unit_number}
                  disabled={saving}
                  onChange={(e) => updateDraft(profile.id, { unit_number: e.target.value })}
                  onBlur={(e) => {
                    const next = e.target.value.trim() || null;
                    if ((profile.unit_number || null) === next) return;
                    saveProfilePatch(profile, { unit_number: next }, "Unit number updated.");
                  }}
                />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  </div>
)}
    </>
  );
}
