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
    driver_type: profile.driver_type || "owner",
    status: profile.status || "active",
    unit_number: profile.unit_number || "",
    language: profile.language || "en",
    date_of_birth: formatDateValue(profile.date_of_birth),
    date_of_start: formatDateValue(profile.date_of_start),
    needs_review: profile.needs_review === true,
  };
}

export default function GroupsPage() {
  const [allProfiles, setAllProfiles] = useState([]);
  const [draftsById, setDraftsById] = useState({});
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState(null);
  const [savingProfileId, setSavingProfileId] = useState(null);
  const [runningAi, setRunningAi] = useState(false);
  const [activeTab, setActiveTab] = useState("all");
  const [statusSort, setStatusSort] = useState("active-first");

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

  const handleRunAiClassification = async () => {
    setRunningAi(true);
    setMessage(null);
    try {
      const result = await api.runGroupStatusAi();
      setMessage({
        type: "success",
        text: `AI classification finished: ${result.updated ?? 0} of ${result.total ?? 0} groups updated.`,
      });
      await fetchProfiles();
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setRunningAi(false);
    }
  };

  const tabCounts = useMemo(() => ({
    all: allProfiles.length,
    active: allProfiles.filter((p) => isDriverActive(p)).length,
    inactive: allProfiles.filter((p) => !isDriverActive(p)).length,
  }), [allProfiles]);

  return (
    <div>
      <div className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h2>👥 Driver Groups</h2>
          <p>Driver profiles are now the source of truth. Edit status, unit, language, birthdays, and date of start here.</p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleRunAiClassification}
          disabled={runningAi || loading}
        >
          {runningAi ? "⏳ Classifying..." : "🤖 Run AI classification now"}
        </button>
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
                <th>Telegram ID</th>
                <th>First Name</th>
                <th>Last Name</th>
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
                <th>Unit Number</th>
                <th>Language</th>
                <th>Date of Birth</th>
                <th>Date of Start</th>
                <th>Review</th>
              </tr>
            </thead>
            <tbody>
              {displayProfiles.map((profile) => {
                const draft = draftsById[profile.id] || profileToDraft(profile);
                const saving = savingProfileId === profile.id;
                const daysUntil = draft.date_of_birth
                  ? getDaysUntilBirthday(draft.date_of_birth)
                  : null;

                return (
                  <tr key={profile.id}>
                    <td>
                      <strong>{profile.group_name || "Unknown group"}</strong>
                      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                        via {formatStatusSource(profile.status_source)}
                      </div>
                    </td>
                    <td><code>{profile.telegram_group_id}</code></td>
                    <td>
                      <input
                        type="text"
                        className="form-input"
                        style={{ minWidth: 120, padding: "4px 8px" }}
                        value={draft.first_name}
                        disabled={saving}
                        onChange={(e) => updateDraft(profile.id, { first_name: e.target.value })}
                        onBlur={(e) => {
                          const next = e.target.value.trim() || null;
                          if ((profile.first_name || null) === next) return;
                          saveProfilePatch(profile, { first_name: next }, "First name updated.");
                        }}
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        className="form-input"
                        style={{ minWidth: 140, padding: "4px 8px" }}
                        value={draft.last_name}
                        disabled={saving}
                        onChange={(e) => updateDraft(profile.id, { last_name: e.target.value })}
                        onBlur={(e) => {
                          const next = e.target.value.trim() || null;
                          if ((profile.last_name || null) === next) return;
                          saveProfilePatch(profile, { last_name: next }, "Last name updated.");
                        }}
                      />
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
                    <td>
                      <select
                        className="form-input"
                        style={{ width: "auto", padding: "4px 8px" }}
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
                    </td>
                    <td>
                      <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 160 }}>
                        <input
                          type="date"
                          className="form-input"
                          style={{ padding: "4px 8px" }}
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
                          <span className="badge badge-active" style={{ alignSelf: "flex-start" }}>
                            in {daysUntil}d
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      <input
                        type="date"
                        className="form-input"
                        style={{ padding: "4px 8px", minWidth: 160 }}
                        value={draft.date_of_start}
                        disabled={saving}
                        onChange={(e) => updateDraft(profile.id, { date_of_start: e.target.value })}
                        onBlur={(e) => {
                          const next = e.target.value || null;
                          if (formatDateValue(profile.date_of_start) === (next || "")) return;
                          saveProfilePatch(profile, { date_of_start: next }, "Date of start updated.");
                        }}
                      />
                    </td>
                    <td>
                      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                        <input
                          type="checkbox"
                          checked={draft.needs_review === true}
                          disabled={saving}
                          onChange={(e) => {
                            const next = e.target.checked;
                            updateDraft(profile.id, { needs_review: next });
                            if ((profile.needs_review === true) === next) return;
                            saveProfilePatch(profile, { needs_review: next }, "Review flag updated.");
                          }}
                        />
                        Review
                      </label>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
