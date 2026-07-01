import React, { useState, useEffect, useCallback, useMemo } from "react";
import * as api from "../api";
import { getDaysUntilBirthday, sortBySoonestBirthday } from "../components/Shared";

function formatDateValue(value) {
  if (!value) return "";
  return String(value).split("T")[0];
}

function isDriverActive(profile) {
  return profile.status !== "inactive";
}

function formatStatusSource(source) {
  if (source === "manual") return "Manual";
  if (source === "ai") return "AI";
  if (source === "bot") return "Bot";
  return "—";
}

function prepareDisplayProfiles(allProfiles, activeTab, statusSort) {
  let list = sortBySoonestBirthday(allProfiles, (p) => p.date_of_birth);

  if (activeTab === "active") {
    list = list.filter((p) => isDriverActive(p));
  } else if (activeTab === "inactive") {
    list = list.filter((p) => !isDriverActive(p));
  } else if (statusSort) {
    list = [...list].sort((a, b) => {
      const aRank = isDriverActive(a) ? 0 : 1;
      const bRank = isDriverActive(b) ? 0 : 1;
      const statusCmp = statusSort === "active-first" ? aRank - bRank : bRank - aRank;
      if (statusCmp !== 0) return statusCmp;
      return getDaysUntilBirthday(a.date_of_birth) - getDaysUntilBirthday(b.date_of_birth);
    });
  }

  return list;
}

function profileToDraft(profile) {
  return {
    first_name: profile.first_name || "",
    last_name: profile.last_name || "",
    secondary_first_name: profile.secondary_first_name || "",
    secondary_last_name: profile.secondary_last_name || "",
    driver_type: profile.driver_type || "owner",
    status: profile.status || "active",
    unit_number: profile.unit_number || "",
    language: profile.language || "en",
    date_of_birth: formatDateValue(profile.date_of_birth),
    date_of_start: formatDateValue(profile.date_of_start),
    needs_review: profile.needs_review === true,
  };
}

function shouldShowTeamInputs(profile, draft) {
  return Boolean(
    profile.secondary_first_name
    || profile.secondary_last_name
    || draft.secondary_first_name
    || draft.secondary_last_name
    || String(profile.group_name || "").includes("/")
  );
}

function driverLabel(profile) {
  const primary = [profile.first_name, profile.last_name].filter(Boolean).join(" ").trim();
  const secondary = [profile.secondary_first_name, profile.secondary_last_name].filter(Boolean).join(" ").trim();
  if (primary && secondary) return `${primary} / ${secondary}`;
  return primary || secondary || profile.display_name || profile.full_name || "";
}

function memberOptionLabel(member) {
  const name = member.display_name || `User ${member.telegram_user_id}`;
  return member.username ? `${name} (@${member.username})` : `${name} (no @username)`;
}

export default function GroupsPage() {
  const [allProfiles, setAllProfiles] = useState([]);
  const [draftsById, setDraftsById] = useState({});
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState(null);
  const [savingProfileId, setSavingProfileId] = useState(null);
  const [syncingAi, setSyncingAi] = useState(false);
  const [activeTab, setActiveTab] = useState("all");
  const [statusSort, setStatusSort] = useState("active-first");
  const [openProfileId, setOpenProfileId] = useState(null);
  // Per-group cache of members the bot has captured: { list, loading, error }.
  const [membersByGroup, setMembersByGroup] = useState({});

  const fetchProfiles = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getDriverProfiles({ includeInactive: true });
      const profiles = Array.isArray(data) ? data : [];
      setAllProfiles(profiles);
      const nextDrafts = {};
      for (const profile of profiles) {
        nextDrafts[profile.id] = profileToDraft(profile);
      }
      setDraftsById(nextDrafts);
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProfiles();
  }, [fetchProfiles]);

  const displayProfiles = useMemo(
    () => prepareDisplayProfiles(allProfiles, activeTab, activeTab === "all" ? statusSort : null),
    [allProfiles, activeTab, statusSort],
  );

  const openProfile = useMemo(
    () => allProfiles.find((p) => p.id === openProfileId) || null,
    [allProfiles, openProfileId],
  );

  const loadGroupMembers = useCallback(async (groupId) => {
    setMembersByGroup((prev) => ({
      ...prev,
      [groupId]: { ...(prev[groupId] || {}), loading: true, error: null },
    }));
    try {
      const list = await api.getGroupMembers(groupId);
      setMembersByGroup((prev) => ({
        ...prev,
        [groupId]: { list, loading: false, error: null },
      }));
    } catch (err) {
      setMembersByGroup((prev) => ({
        ...prev,
        [groupId]: { list: [], loading: false, error: err.message },
      }));
    }
  }, []);

  useEffect(() => {
    if (openProfile?.group_id) loadGroupMembers(openProfile.group_id);
  }, [openProfile?.group_id, loadGroupMembers]);

  const updateDraft = (profileId, patch) => {
    setDraftsById((prev) => ({
      ...prev,
      [profileId]: {
        ...(prev[profileId] || {}),
        ...patch,
      },
    }));
  };

  const saveProfilePatch = async (profile, patch, successText) => {
    setSavingProfileId(profile.id);
    setMessage(null);
    try {
      await api.updateDriverProfile(profile.id, patch);
      setMessage({ type: "success", text: successText });
      await fetchProfiles();
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setSavingProfileId(null);
    }
  };

  const toggleStatusSort = () => {
    setStatusSort((s) => (s === "active-first" ? "inactive-first" : "active-first"));
  };

  const handleAiSync = async () => {
    if (!window.confirm(
      "Run one smart AI pass that re-reads every driver group title, fills names, team-driver fields, unit number, type, "
      + "and status where they are not manually locked?"
    )) return;
    setSyncingAi(true);
    setMessage(null);
    try {
      const result = await api.runDriverProfilesAiSync(true);
      setMessage({
        type: "success",
        text: `AI sync finished: ${result.updated ?? 0} of ${result.total ?? 0} driver groups enriched.`,
      });
      await fetchProfiles();
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setSyncingAi(false);
    }
  };

  // Selecting a captured member makes them the single source of truth for the
  // driver: BOTH their numeric telegram_user_id and username are stored on the
  // driver_profiles row (empty selection clears both).
  const handleMemberSelect = (profile, memberId) => {
    const cache = membersByGroup[profile.group_id];
    const member = (cache?.list || []).find((m) => m.telegram_user_id === memberId) || null;
    saveProfilePatch(
      profile,
      {
        telegram_user_id: member ? member.telegram_user_id : null,
        telegram_username: member ? member.username : null,
      },
      member
        ? `Driver linked to ${memberOptionLabel(member)}.`
        : "Driver Telegram link cleared.",
    );
  };

  const tabCounts = useMemo(() => ({
    all: allProfiles.length,
    active: allProfiles.filter((p) => isDriverActive(p)).length,
    inactive: allProfiles.filter((p) => !isDriverActive(p)).length,
  }), [allProfiles]);

  const renderDriverModal = () => {
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
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, minHeight: 38 }}>
                    <input
                      type="checkbox"
                      checked={draft.needs_review === true || profile.duplicate_review_required === true}
                      disabled={saving}
                      onChange={(e) => {
                        const next = e.target.checked;
                        updateDraft(profile.id, { needs_review: next });
                        if ((profile.needs_review === true) === next && profile.duplicate_review_required !== true) return;
                        saveProfilePatch(profile, { needs_review: next }, "Review flag updated.");
                      }}
                    />
                    {profile.duplicate_review_required ? "Review required" : "Needs review"}
                  </label>
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
  };

  return (
    <div>
      <div className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h2>👥 Driver Groups</h2>
          <p>Driver Groups is the source of truth for driver identity, status, truck, and team-driver structure across Home Time and Bot Group Access. Click a driver name to edit all details.</p>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleAiSync}
            disabled={syncingAi || loading}
            title="One smart AI pass fills names, team fields, unit, type, and status without overwriting manual corrections"
          >
            {syncingAi ? "⏳ Running AI sync..." : "🤖 AI: enrich status + identity"}
          </button>
        </div>
      </div>

      {message && (
        <div className={`alert alert-${message.type}`}>
          {message.text}
        </div>
      )}

      <div className="broadcast-tabs" style={{ marginBottom: 16 }}>
        <button
          type="button"
          className={`broadcast-tab-btn ${activeTab === "all" ? "active" : ""}`}
          onClick={() => setActiveTab("all")}
        >
          All ({tabCounts.all})
        </button>
        <button
          type="button"
          className={`broadcast-tab-btn ${activeTab === "active" ? "active" : ""}`}
          onClick={() => setActiveTab("active")}
        >
          Active Drivers ({tabCounts.active})
        </button>
        <button
          type="button"
          className={`broadcast-tab-btn ${activeTab === "inactive" ? "active" : ""}`}
          onClick={() => setActiveTab("inactive")}
        >
          Inactive Drivers ({tabCounts.inactive})
        </button>
      </div>

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

      {renderDriverModal()}
    </div>
  );
}
