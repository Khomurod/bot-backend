import React, { Suspense, lazy, useState } from "react";
import TabBar, { tabPanelProps } from "../components/ui/TabBar";

/**
 * Settings — tab shell. Each tab lives in ./settings/ and is lazy-loaded so
 * its code is fetched only when the tab is opened (smaller initial bundle).
 *
 * Secrets are write-only from the UI: the API returns only a masked "••••abcd"
 * hint and never the raw value. Leaving a key field blank on Save keeps the
 * stored value.
 *
 * Notifications, Auto Reactions and Bot Group Access are NOT integrations —
 * nothing to authenticate — but they are configuration, and they were each a
 * top-level sidebar entry or buried inside another tab before.
 *
 * AUTO REACTIONS AND GROUP ACCESS ARE TWO TABS, NOT ONE "BOT SETTINGS" TAB WITH
 * TWO PANELS. The grouped version was written first and reverted: a single page
 * key for two screens meant a held `#group_access` link resolved to the group
 * and then opened the OTHER one, silently and indistinguishably from the
 * `#auto_reactions` link. One key per screen is what makes a link mean
 * something, and a tab is already lazy and already shown one at a time, so the
 * grouping bought nothing the tab bar was not already doing.
 *
 * The Samsara tab is ONE integration rather than one screen per moving part:
 * the connection, the safety-event switches, missing-video recovery and the
 * driver-group music overlay (still its own component, ./settings/
 * SafetyEventsTab.jsx) all live under it.
 */

const LocationProvidersTab = lazy(() => import("./settings/LocationProvidersTab"));
const RingCentralTab = lazy(() => import("./settings/RingCentralTab"));
const TelegramGroupsTab = lazy(() => import("./settings/TelegramGroupsTab"));
const SamsaraTab = lazy(() => import("./settings/SamsaraTab"));
const DispatcherBoardTab = lazy(() => import("./settings/DispatcherBoardTab"));
const AiTab = lazy(() => import("./settings/AiTab"));
const NotificationsTab = lazy(() => import("./settings/NotificationsTab"));
const SafetyApprovalsTab = lazy(() => import("./settings/SafetyApprovalsTab"));
const AutoReactionsPanel = lazy(() => import("./settings/bot/AutoReactionsPanel"));
const GroupAccessPanel = lazy(() => import("./settings/bot/GroupAccessPanel"));
const RetiredLeftoversTab = lazy(() => import("./settings/RetiredLeftoversTab"));
const GrossRaceTab = lazy(() => import("./settings/GrossRaceTab"));
const MetaCrmTab = lazy(() => import("./settings/MetaCrmTab"));

const SETTINGS_TABS = [
  { key: "location", label: "Live Location" },
  { key: "ringcentral", label: "RingCentral" },
  { key: "metacrm", label: "Facebook ↔ Bitrix" },
  { key: "groups", label: "Telegram Groups" },
  { key: "samsara", label: "Samsara" },
  { key: "board", label: "Dispatcher Board" },
  { key: "safety", label: "Safety Approvals" },
  { key: "ai", label: "AI" },
  { key: "notifications", label: "Notifications" },
  { key: "reactions", label: "Auto Reactions" },
  { key: "access", label: "Bot Group Access" },
  { key: "grossrace", label: "Gross Grand Prix" },
  { key: "leftovers", label: "Retired Leftovers" },
];
const TAB_KEYS = SETTINGS_TABS.map((t) => t.key);

/**
 * `initialTab` is which tab to OPEN ON, not which tab is shown — the buttons
 * below still own that afterwards. Three sidebar entries point here (Integrations,
 * Dispatcher Board, AI & Autonomy) because "Settings" alone does not say which
 * settings; an unrecognised value opens the first tab rather than a blank page.
 */
export default function SettingsPage({ initialTab }) {
  const [tab, setTab] = useState(() => (TAB_KEYS.includes(initialTab) ? initialTab : "location"));
  return (
    <div>
      <div className="page-header">
        <h2>Settings</h2>
        <p>Integration credentials and configuration for the bot's external services.</p>
      </div>
      <TabBar tabs={SETTINGS_TABS} value={tab} onChange={setTab} ariaLabel="Settings sections" idPrefix="settings" />
      <div {...tabPanelProps("settings", tab)}>
      <Suspense fallback={<div className="loading"><div className="spinner"></div> Loading…</div>}>
        {tab === "location" && <LocationProvidersTab />}
        {tab === "ringcentral" && <RingCentralTab />}
        {tab === "metacrm" && <MetaCrmTab />}
        {tab === "groups" && <TelegramGroupsTab />}
        {tab === "samsara" && <SamsaraTab />}
        {tab === "board" && <DispatcherBoardTab />}
        {tab === "safety" && <SafetyApprovalsTab />}
        {tab === "ai" && <AiTab />}
        {tab === "notifications" && <NotificationsTab />}
        {tab === "reactions" && <AutoReactionsPanel />}
        {tab === "access" && <GroupAccessPanel />}
        {tab === "grossrace" && <GrossRaceTab />}
        {tab === "leftovers" && <RetiredLeftoversTab />}
      </Suspense>
      </div>
    </div>
  );
}
