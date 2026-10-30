import React, { useState } from "react";
import useTabRoute from "../navigation/useTabRoute";
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
const HOME_TIME_TABS = [
  { key: "overview", label: "Overview" },
  { key: "efficiency", label: "Efficiency" },
  { key: "settings", label: "Settings & Alerts" },
];

/** The open tab is the second half of the address (`#home_time/efficiency`). */
export default function HomeTimePage({ tab: routeTab, onTabChange }) {
  const [status, setStatus] = useState(null);
  const [activeTab, setActiveTab] = useTabRoute(HOME_TIME_TABS.map((t) => t.key), { tab: routeTab, onTabChange });

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
        tabs={HOME_TIME_TABS}
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

      <ScreenshotImportCard {...importer} />

      <UnlinkedActivityCard unlinkedActivity={overview.unlinkedActivity} />

      {isDetailOpen && selectedStatus && (
        <DriverDetailModal {...overview} flash={flash} />
      )}
      </>
      )}

      {/* Configuration on its own tab rather than under the driver list: the
          policy, the notice groups and accounting's violation alerts are set
          once and were two screenfuls below the table people use daily. */}
      {activeTab === "settings" && (
      <>
      <HomeTimeSettingsCard settings={settings} saving={saving} onSave={saveSettings} />

      <ViolationAlertsCard settings={settings} saving={saving} onSave={saveSettings} />
      </>
      )}
      </div>
    </div>
  );
}
