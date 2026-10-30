import React, { useState } from "react";
import HomeTimeEfficiencyTab from "./HomeTimeEfficiencyTab";
import HomeTimeSettingsCard from "./HomeTimeSettingsCard";
import ViolationAlertsCard from "./homeTime/ViolationAlertsCard";
import { useHomeTimeOverview } from "./homeTime/useHomeTimeOverview";
import { useHomeTimeImport } from "./homeTime/useHomeTimeImport";
import { DriverListCard } from "./homeTime/DriverListCard";
import { ScreenshotImportCard } from "./homeTime/ScreenshotImportCard";
import { UnlinkedActivityCard } from "./homeTime/UnlinkedActivityCard";
import { DriverDetailModal } from "./homeTime/DriverDetailModal";
import TabBar, { tabPanelProps } from "../components/ui/TabBar";

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

      <TabBar
        tabs={[
          { key: "overview", label: "Overview" },
          { key: "efficiency", label: "Driver Home Time Efficiency" },
        ]}
        value={activeTab}
        onChange={setActiveTab}
        ariaLabel="Home time views"
        idPrefix="home-time"
      />

      <div {...tabPanelProps("home-time", activeTab)}>

      {/* Rendered ONCE. It used to appear twice — the whole efficiency report
          drawn two times on the same tab — until the October 2026 redesign. */}
      {activeTab === "efficiency" && <HomeTimeEfficiencyTab flash={flash} />}

      {activeTab === "overview" && (
      <>
      <DriverListCard {...overview} />

      <HomeTimeSettingsCard settings={settings} saving={saving} onSave={saveSettings} />

      <ViolationAlertsCard settings={settings} saving={saving} onSave={saveSettings} />

      <ScreenshotImportCard {...importer} />

      <UnlinkedActivityCard unlinkedActivity={overview.unlinkedActivity} />

      {isDetailOpen && selectedStatus && (
        <DriverDetailModal {...overview} flash={flash} />
      )}
      </>
      )}
      </div>
    </div>
  );
}
