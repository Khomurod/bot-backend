import React, { useState } from "react";
import HomeTimeEfficiencyTab from "./HomeTimeEfficiencyTab";
import HomeTimeSettingsCard from "./HomeTimeSettingsCard";
import { useHomeTimeOverview } from "./homeTime/useHomeTimeOverview";
import { useHomeTimeImport } from "./homeTime/useHomeTimeImport";
import { DriverListCard } from "./homeTime/DriverListCard";
import { ScreenshotImportCard } from "./homeTime/ScreenshotImportCard";
import { DriverDetailModal } from "./homeTime/DriverDetailModal";

/**
 * Driver Home Time — page container.
 *
 * LAYOUT AND WIRING ONLY:
 *
 *   homeTime/labels.js               PURE label + formatting rules
 *   homeTime/useHomeTimeOverview.js  statuses, trips, requests, every edit
 *   homeTime/useHomeTimeImport.js    the two-step screenshot import
 *   homeTime/DriverListCard.jsx      the sortable driver table
 *   homeTime/ScreenshotImportCard.jsx the import UI
 *   homeTime/DriverDetailModal.jsx   the per-driver popup and its forms
 *
 * The pure label rules are their own module because they encode a business
 * distinction, not formatting: owner operators are OUTSIDE the road-allowance
 * and bonus policy rather than failing it, and an awaiting-dates request on the
 * internal clarification channel is waiting on staff, not on the driver.
 * Getting either wrong sends someone chasing the wrong person.
 *
 * Every edit reloads the whole overview, because the server recomputes bonus,
 * on-road days and next-eligible-home-time from each write.
 */
export default function HomeTimePage() {
  const [status, setStatus] = useState(null);
  const [activeTab, setActiveTab] = useState("overview");

  const flash = (type, text) => setStatus({ type, text });

  const overview = useHomeTimeOverview(flash, setStatus);
  const importer = useHomeTimeImport(flash, setStatus, overview.load);

  const { loading, settings, saving, saveSettings, isDetailOpen, selectedStatus } = overview;

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
          The main table now carries the operational view directly. Click any column header to sort, then click a row
          to open the full driver popup.
        </p>
      </div>

      {status && (
        <div className={`alert alert-${status.type}`} style={{ marginBottom: 16 }}>
          {status.text}
        </div>
      )}

      <div className="home-time-tabs" style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button
          type="button"
          className={`btn ${activeTab === "overview" ? "btn-primary" : "btn-secondary"}`}
          onClick={() => setActiveTab("overview")}
        >
          Overview
        </button>
        <button
          type="button"
          className={`btn ${activeTab === "efficiency" ? "btn-primary" : "btn-secondary"}`}
          onClick={() => setActiveTab("efficiency")}
        >
          Driver Home Time Efficiency
        </button>
      </div>

      {activeTab === "efficiency" && <HomeTimeEfficiencyTab flash={flash} />}


      {activeTab === "efficiency" && <HomeTimeEfficiencyTab flash={flash} />}

      {activeTab === "overview" && (
      <>
      <DriverListCard {...overview} />

      <HomeTimeSettingsCard settings={settings} saving={saving} onSave={saveSettings} />

      <ScreenshotImportCard {...importer} />

      {isDetailOpen && selectedStatus && (
        <DriverDetailModal {...overview} flash={flash} />
      )}
      </>
      )}
    </div>
  );
}
