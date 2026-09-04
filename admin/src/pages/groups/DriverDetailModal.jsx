import React from "react";
import { getDaysUntilBirthday } from "../../components/Shared";
import {
  formatDateValue, profileToDraft, shouldShowTeamInputs,
  driverLabel, memberOptionLabel, normalizeManualUsername,
} from "./driverProfileShaping";

/**
 * The driver detail editor: identity, team-driver pair, unit, type, status,
 * birthday, and the Telegram link.
 *
 * THREE WAYS TO LINK A DRIVER, all reaching the same row:
 *   - pick a captured group member (stores BOTH numeric id and username);
 *   - type an @username by hand, for a driver the bot has not seen text from
 *     yet (username only — a stale numeric id is dropped so it cannot tag the
 *     wrong person);
 *   - clear the link entirely.
 *
 * A stored selection that is missing from the member cache is kept selectable
 * rather than silently reading as "not linked" — the cache only holds members
 * the bot has seen recently.
 *
 * Presentational: every write goes through a handler from useDriverProfiles.
 *
 * Split out of admin/src/pages/GroupsPage.jsx.
 */
export function DriverDetailModal({
  openProfile, draftsById, savingProfileId, membersByGroup, setOpenProfileId,
  updateDraft, saveProfilePatch,
  handleMemberSelect, handleManualUsernameSave, handleClearTelegram,
}) {
  const profile = openProfile;
  if (!profile) return null;

  const draft = draftsById[profile.id] || profileToDraft(profile);
  const saving = savingProfileId === profile.id;
  const teamInputs = shouldShowTeamInputs(profile, draft);
  const daysUntil = draft.date_of_birth ? getDaysUntilBirthday(draft.date_of_birth) : null;
  const membersState = membersByGroup[profile.group_id] || { list: [], loading: true, error: null };
  const members = Array.isArray(membersState.list) ? membersState.list : [];
  const selectedId = profile.telegram_user_id || "";
  // The stored selection may predate the member cache (or the member stopped
  // interacting) — keep it selectable instead of silently showing "not linked".
  const selectedMissing = selectedId && !members.some((m) => m.telegram_user_id === selectedId);

  const fieldLabelStyle = { fontSize: 12, color: "var(--text-muted)", marginBottom: 4, display: "block" };

  return (
<div className="home-time-modal-backdrop" onClick={() => setOpenProfileId(null)}>
  <div
    className="card home-time-modal-card"
    style={{ width: "min(680px, 100%)" }}
    onClick={(e) => e.stopPropagation()}
  >
    <div className="home-time-modal-header">
      <div>
        <div className="home-time-modal-kicker">Driver details</div>
        <h3>{driverLabel(profile) || profile.group_name || "Driver"}</h3>
        <p style={{ color: "var(--text-muted)" }}>
          {profile.group_name || "Unknown group"} · Telegram ID <code>{profile.telegram_group_id}</code>
        </p>
      </div>
      <div className="home-time-modal-actions">
        {saving && <span className="spinner" style={{ width: 16, height: 16 }} />}
        <button
          type="button"
          className="home-time-modal-close"
          onClick={() => setOpenProfileId(null)}
          aria-label="Close driver details"
        >
          ×
        </button>
      </div>
    </div>

    <div className="home-time-modal-body">
      <div style={{ display: "grid", gap: 14 }}>
        <div>
          <label style={fieldLabelStyle}>Driver Username (Telegram member seen in this group)</label>
          <select
            className="form-input"
            value={selectedId}
            disabled={saving || membersState.loading}
            onChange={(e) => handleMemberSelect(profile, e.target.value)}
          >
            <option value="">
              {membersState.loading ? "Loading members…" : "— not linked —"}
            </option>
            {selectedMissing && (
              <option value={selectedId}>
                {profile.telegram_username
                  ? `@${profile.telegram_username} (id ${selectedId})`
                  : `User ${selectedId}`}
              </option>
            )}
            {members.map((m) => (
              <option key={m.telegram_user_id} value={m.telegram_user_id}>
                {memberOptionLabel(m)}
              </option>
            ))}
          </select>
          {membersState.error && (
            <div style={{ fontSize: 12, color: "#ef4444", marginTop: 4 }}>{membersState.error}</div>
          )}
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
            Selecting a member stores their Telegram user id + username as the source of truth
            for tagging (Fuel Monitor, check-ins) — drivers without an @username are tagged via
            an inline mention. Telegram bots cannot list all group members, so only people the
            bot has seen interact here appear; a silent member shows up after their first
            message in the group.
          </div>
        </div>

        <div>
          <label style={fieldLabelStyle}>Or enter username manually</label>
          <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
            <input
              type="text"
              className="form-input"
              placeholder="@john_driver"
              value={draft.telegram_username}
              disabled={saving}
              style={{ flex: 1 }}
              onChange={(e) => updateDraft(profile.id, { telegram_username: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleManualUsernameSave(profile, draft.telegram_username);
                }
              }}
            />
            <button
              type="button"
              className="btn"
              disabled={saving || !normalizeManualUsername(draft.telegram_username)}
              onClick={() => handleManualUsernameSave(profile, draft.telegram_username)}
            >
              Save username
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={saving || (!profile.telegram_user_id && !profile.telegram_username)}
              onClick={() => handleClearTelegram(profile)}
            >
              Clear
            </button>
          </div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>
            {profile.telegram_user_id ? (
              <>
                Active: <b>inline mention via Telegram user id</b> (<code>{profile.telegram_user_id}</code>)
                {profile.telegram_username
                  ? <> — <b>@{profile.telegram_username}</b> kept as a fallback.</>
                  : <>.</>}
                {" "}The dropdown selection takes priority over a manually typed username.
              </>
            ) : profile.telegram_username ? (
              <>
                Active: <b>@{profile.telegram_username}</b> (manual). No numeric id yet — it links
                automatically the first time this username texts in the group, upgrading to the
                more reliable id mention.
              </>
            ) : (
              <>Not linked — the driver is addressed by their plain name.</>
            )}
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label style={fieldLabelStyle}>First Name</label>
            <input
              type="text"
              className="form-input"
              value={draft.first_name}
              disabled={saving}
              onChange={(e) => updateDraft(profile.id, { first_name: e.target.value })}
              onBlur={(e) => {
                const next = e.target.value.trim() || null;
                if ((profile.first_name || null) === next) return;
                saveProfilePatch(profile, { first_name: next }, "First name updated.");
              }}
            />
          </div>
          <div>
            <label style={fieldLabelStyle}>Last Name</label>
            <input
              type="text"
              className="form-input"
              value={draft.last_name}
              disabled={saving}
              onChange={(e) => updateDraft(profile.id, { last_name: e.target.value })}
              onBlur={(e) => {
                const next = e.target.value.trim() || null;
                if ((profile.last_name || null) === next) return;
                saveProfilePatch(profile, { last_name: next }, "Last name updated.");
              }}
            />
          </div>
        </div>

        {teamInputs && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label style={fieldLabelStyle}>2nd First Name (team driver)</label>
              <input
                type="text"
                className="form-input"
                value={draft.secondary_first_name}
                disabled={saving}
                placeholder="2nd first name"
                onChange={(e) => updateDraft(profile.id, { secondary_first_name: e.target.value })}
                onBlur={(e) => {
                  const next = e.target.value.trim() || null;
                  if ((profile.secondary_first_name || null) === next) return;
                  saveProfilePatch(profile, { secondary_first_name: next }, "Secondary first name updated.");
                }}
              />
            </div>
            <div>
              <label style={fieldLabelStyle}>2nd Last Name (team driver)</label>
              <input
                type="text"
                className="form-input"
                value={draft.secondary_last_name}
                disabled={saving}
                placeholder="2nd last name"
                onChange={(e) => updateDraft(profile.id, { secondary_last_name: e.target.value })}
                onBlur={(e) => {
                  const next = e.target.value.trim() || null;
                  if ((profile.secondary_last_name || null) === next) return;
                  saveProfilePatch(profile, { secondary_last_name: next }, "Secondary last name updated.");
                }}
              />
            </div>
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label style={fieldLabelStyle}>Language</label>
            <select
              className="form-input"
              value={draft.language}
              disabled={saving}
              onChange={(e) => {
                const next = e.target.value;
                updateDraft(profile.id, { language: next });
                if ((profile.language || "en") === next) return;
                saveProfilePatch(profile, { language: next }, "Language updated.");
              }}
            >
              <option value="en">🇺🇸 English</option>
              <option value="ru">🇷🇺 Russian</option>
              <option value="uz">🇺🇿 Uzbek</option>
            </select>
          </div>
          <div>
            <label style={fieldLabelStyle}>Review</label>
            <label
              style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, minHeight: 38 }}
              title={
                "Advisory flag only — it never blocks status sync, live location, home-time or any automated behavior. "
                + "It just marks this profile for a human to check and powers the “Needs review only” filter. "
                + "It is set automatically when key fields are missing (name / unit) or a team name is unresolved, "
                + "and is auto-checked while the driver has a duplicate/identity conflict (see below). "
                + "You can tick it by hand to queue a profile for review, or untick it once you've checked it."
              }
            >
              <input
                type="checkbox"
                checked={draft.needs_review === true || profile.duplicate_review_required === true}
                disabled={saving || profile.duplicate_review_required === true}
                onChange={(e) => {
                  const next = e.target.checked;
                  updateDraft(profile.id, { needs_review: next });
                  if ((profile.needs_review === true) === next && profile.duplicate_review_required !== true) return;
                  saveProfilePatch(profile, { needs_review: next }, "Review flag updated.");
                }}
              />
              {profile.duplicate_review_required ? "Review required" : "Needs review"}
            </label>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2, maxWidth: 260 }}>
              {profile.duplicate_review_required
                ? (profile.duplicate_conflict
                  ? "Auto-flagged: more than one active group for this driver. Resolve the duplicate (deactivate the wrong group) to clear it."
                  : "Auto-flagged: this profile can't be matched to a unique driver. Fix the name/unit to clear it.")
                : "Manual flag: mark a profile for a human to double-check. Doesn't affect any automated behavior."}
            </div>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label style={fieldLabelStyle}>Date of Birth</label>
            <input
              type="date"
              className="form-input"
              value={draft.date_of_birth}
              disabled={saving}
              onChange={(e) => updateDraft(profile.id, { date_of_birth: e.target.value })}
              onBlur={(e) => {
                const next = e.target.value || null;
                if (formatDateValue(profile.date_of_birth) === (next || "")) return;
                saveProfilePatch(profile, { date_of_birth: next }, "Date of birth updated.");
              }}
            />
            {draft.date_of_birth && daysUntil !== null && daysUntil <= 7 && (
              <span className="badge badge-active" style={{ marginTop: 6, display: "inline-block" }}>
                birthday in {daysUntil}d
              </span>
            )}
          </div>
          <div>
            <label style={fieldLabelStyle}>Date of Start</label>
            <input
              type="date"
              className="form-input"
              value={draft.date_of_start}
              disabled={saving}
              onChange={(e) => updateDraft(profile.id, { date_of_start: e.target.value })}
              onBlur={(e) => {
                const next = e.target.value || null;
                if (formatDateValue(profile.date_of_start) === (next || "")) return;
                saveProfilePatch(profile, { date_of_start: next }, "Date of start updated.");
              }}
            />
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
  );
}
