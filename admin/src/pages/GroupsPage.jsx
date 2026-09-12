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
/**
 * The five views, in the order somebody reads them. `key` is what `groupView`
 * returns, so the tab bar and the classifier cannot drift apart.
 */
const TABS = [
  { key: "all", label: "All" },
  { key: "active", label: "Active Drivers" },
  { key: "inactive", label: "Inactive Drivers" },
  { key: "company", label: "Company Chats" },
  { key: "review", label: "Needs Review" },
];

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


      {/*
        FIVE TABS, ONE CLASSIFIER. Every one of them filters by `groupView`, so
        a chat appears on exactly one — which a per-tab predicate stops
        guaranteeing the moment somebody edits one of them.
      */}
      <div className="broadcast-tabs" style={{ marginBottom: 16 }}>
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            className={`broadcast-tab-btn ${activeTab === key ? "active" : ""}`}
            onClick={() => setActiveTab(key)}
          >
            {label} ({tabCounts[key] ?? 0})
          </button>
        ))}
      </div>

      {activeTab === "review" && tabCounts.review > 0 && (
        <div className="muted" style={{ marginBottom: 12 }}>
          These chats have something unresolved — Wenze flagged them, a duplicate needs
          a decision, or a question about who they are is still open on Needs Attention.
        </div>
      )}
      {activeTab === "company" && (
        <div className="muted" style={{ marginBottom: 12 }}>
          Chats that are not a driver&apos;s. They receive no broadcasts and no
          BOL/POD documents.
        </div>
      )}

      <DriverProfilesTable {...profiles} />

      <DriverDetailModal {...profiles} />
    </div>
  );
}
