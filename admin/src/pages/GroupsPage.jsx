import React from "react";
import { useDriverProfiles } from "./groups/useDriverProfiles";
import { DriverProfilesTable } from "./groups/DriverProfilesTable";
import { DriverDetailModal } from "./groups/DriverDetailModal";

/**
 * Driver Groups — page container.
 *
 * LAYOUT AND WIRING ONLY:
 *
 *   ./groups/driverProfileShaping.js  PURE identity/status/validation rules
 *   ./groups/useDriverProfiles.js     the list, the drafts, every write
 *   ./groups/DriverProfilesTable.jsx  the table + its loading/empty states
 *   ./groups/DriverDetailModal.jsx    the full editor for one driver
 *
 * This screen is the SOURCE OF TRUTH for driver identity, status, truck and
 * team-driver structure — Home Time and Bot Group Access read what is set
 * here — which is why the shaping rules live in their own pure module rather
 * than inline in the table.
 */
export default function GroupsPage() {
  const profiles = useDriverProfiles();
  const {
    loading, message, syncingAi, activeTab, setActiveTab, tabCounts,
  } = profiles;

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
            onClick={profiles.handleAiSync}
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

      <DriverProfilesTable {...profiles} />

      <DriverDetailModal {...profiles} />
    </div>
  );
}
