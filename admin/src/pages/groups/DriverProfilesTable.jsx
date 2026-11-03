import React from "react";
import { formatStatusSource, driverLabel, profileToDraft, needsReview, groupView } from "./driverProfileShaping";

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
 * ONE IDENTITY PER ROW (November 2026). The row leads with the driver; the
 * group title — which repeats the unit, name and type the next columns show —
 * is a grey line under the name, and "via" appears only when a source is
 * known. A company chat shows no driver type or unit controls: it has neither.
 * On a phone each row is a card (wz-card-table), so Status and Unit are no
 * longer behind a sideways scroll.
 *
 * Split out of admin/src/pages/GroupsPage.jsx.
 */
export function DriverProfilesTable({
  loading, displayProfiles, draftsById, savingProfileId,
  statusSort, toggleStatusSort, setOpenProfileId,
  updateDraft, saveProfilePatch, activeTab, query = "", samsaraEnforced = null,
}) {
  return (
    <>

{loading ? (
  <div className="loading"><div className="spinner"></div> Loading driver profiles...</div>
) : displayProfiles.length === 0 ? (
  query.trim() ? (
    <div className="empty-state">
      <div className="icon">🔎</div>
      <h3>Nothing in this view matches “{query.trim()}”</h3>
      <p>Try a unit number, part of a name, or another view.</p>
    </div>
  ) : (
  <div className="empty-state">
    <div className="icon">👥</div>
    <h3>No driver profiles in this view</h3>
    <p>Run the backfill script and ensure the bot has joined driver groups.</p>
  </div>
  )
) : (
  <div className="table-container">
    {/* On a phone the header row is hidden (each row is a card), and the
        status sort lives in that header — so the phone gets its own button. */}
    {activeTab === "all" && (
      <button type="button" className="btn btn-ghost btn-sm wz-card-table-phone-control" onClick={toggleStatusSort}>
        Sort by status: {statusSort === "active-first" ? "Active first" : "Inactive first"}
      </button>
    )}
    <table className="wz-card-table">
      <thead>
        <tr>
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
          // A chat that is not a driver's has no driver type and no truck.
          const company = groupView(profile) === "company";

          return (
            <tr key={profile.id}>
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
                    color: "var(--accent-text)",
                    textDecoration: "underline",
                    textAlign: "left",
                  }}
                >
                  {name || (company ? profile.group_name || "Unknown group" : "— set driver —")}
                </button>
                {profile.unit_number && !company && (
                  <span style={{ marginLeft: 6, fontSize: 12, color: "var(--text-secondary)" }}>· unit {profile.unit_number}</span>
                )}
                {(name || !company) && (
                  <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                    {profile.group_name || "Unknown group"}
                    {profile.status_source && <> · via {formatStatusSource(profile.status_source)}</>}
                  </div>
                )}
                {needsReview(profile) && (
                  <div style={{ fontSize: 11, color: "var(--warning)" }}>Needs review</div>
                )}
                {/* Only the exception is shown: ON is every group's default. */}
                {!company && profile.samsara_driver_alerts_enabled === false && (
                  <div style={{ fontSize: 11, color: "var(--warning)" }}>
                    Samsara alerts in group: off{samsaraEnforced !== true ? " (not applied yet)" : ""}
                  </div>
                )}
                {profile.duplicate_conflict && (
                  <div style={{ fontSize: 11, color: "var(--warning)" }}>
                    Multiple active duplicates - review required
                  </div>
                )}
                {!profile.duplicate_conflict && profile.duplicate_group_count > 1 && (
                  <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                    Linked duplicate set ({profile.duplicate_group_count} groups)
                  </div>
                )}
                {profile.telegram_username ? (
                  <div style={{ fontSize: 11, color: "var(--text-muted)" }}>@{profile.telegram_username}</div>
                ) : profile.telegram_user_id ? (
                  <div style={{ fontSize: 11, color: "var(--text-muted)" }}>linked (no @username)</div>
                ) : null}
              </td>
              <td data-label="Type">
                {company ? <span className="muted">—</span> : (
                <select
                  className="form-input"
                  style={{ width: "auto", padding: "4px 8px" }}
                  aria-label={`Driver type for ${name || profile.group_name || "this group"}`}
                  value={draft.driver_type}
                  disabled={saving}
                  onChange={(e) => {
                    const next = e.target.value;
                    updateDraft(profile.id, { driver_type: next });
                    if ((profile.driver_type || "owner") === next) return;
                    saveProfilePatch(profile, { driver_type: next }, "Driver type updated.");
                  }}
                >
                  <option value="owner">Owner Operator</option>
                  <option value="company_driver">Company Driver</option>
                  <option value="lease">Lease Driver</option>
                </select>
                )}
              </td>
              <td data-label="Status">
                <select
                  className="form-input"
                  style={{ width: "auto", padding: "4px 8px" }}
                  aria-label={`Status for ${name || profile.group_name || "this group"}`}
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
              <td data-label="Unit">
                {company ? <span className="muted">{profile.unit_number || "—"}</span> : (
                <input
                  type="text"
                  className="form-input"
                  aria-label={`Unit for ${name || profile.group_name || "this group"}`}
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
                )}
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
