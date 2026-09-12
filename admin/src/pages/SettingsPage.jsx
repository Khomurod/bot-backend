import React, { Suspense, lazy, useState } from "react";

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
const GmapsTab = lazy(() => import("./settings/GmapsTab"));
const SamsaraTab = lazy(() => import("./settings/SamsaraTab"));
const DispatcherBoardTab = lazy(() => import("./settings/DispatcherBoardTab"));
const BolPodTab = lazy(() => import("./settings/BolPodTab"));
const AiTab = lazy(() => import("./settings/AiTab"));
const NotificationsTab = lazy(() => import("./settings/NotificationsTab"));
const AutoReactionsPanel = lazy(() => import("./settings/bot/AutoReactionsPanel"));
const GroupAccessPanel = lazy(() => import("./settings/bot/GroupAccessPanel"));
const RetiredLeftoversTab = lazy(() => import("./settings/RetiredLeftoversTab"));

const TAB_KEYS = [
  "location", "ringcentral", "groups", "gmaps", "samsara",
  "board", "bolpod", "ai", "notifications", "reactions", "access", "leftovers",
];

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
        <h2>⚙️ Settings</h2>
        <p>Integration credentials and configuration for the bot's external services.</p>
      </div>
      <div className="ios-glass ai-tab-bar" style={{ marginBottom: 20 }}>
        <button className={`btn ${tab === "location" ? "btn-primary" : "btn-ghost"} touch-target`} onClick={() => setTab("location")}>📡 Live Location</button>
        <button className={`btn ${tab === "ringcentral" ? "btn-primary" : "btn-ghost"} touch-target`} onClick={() => setTab("ringcentral")}>📞 RingCentral</button>
        <button className={`btn ${tab === "groups" ? "btn-primary" : "btn-ghost"} touch-target`} onClick={() => setTab("groups")}>💬 Telegram Groups</button>
        <button className={`btn ${tab === "gmaps" ? "btn-primary" : "btn-ghost"} touch-target`} onClick={() => setTab("gmaps")}>🗺️ GMaps</button>
        <button className={`btn ${tab === "samsara" ? "btn-primary" : "btn-ghost"} touch-target`} onClick={() => setTab("samsara")}>🛰️ Samsara</button>
        <button className={`btn ${tab === "board" ? "btn-primary" : "btn-ghost"} touch-target`} onClick={() => setTab("board")}>🗂️ Dispatcher Board</button>
        <button className={`btn ${tab === "bolpod" ? "btn-primary" : "btn-ghost"} touch-target`} onClick={() => setTab("bolpod")}>📄 BOL / POD</button>
        <button className={`btn ${tab === "ai" ? "btn-primary" : "btn-ghost"} touch-target`} onClick={() => setTab("ai")}>🤖 AI</button>
        <button className={`btn ${tab === "notifications" ? "btn-primary" : "btn-ghost"} touch-target`} onClick={() => setTab("notifications")}>🔔 Notifications</button>
        <button className={`btn ${tab === "reactions" ? "btn-primary" : "btn-ghost"} touch-target`} onClick={() => setTab("reactions")}>😀 Auto Reactions</button>
        <button className={`btn ${tab === "access" ? "btn-primary" : "btn-ghost"} touch-target`} onClick={() => setTab("access")}>🔍 Bot Group Access</button>
        <button className={`btn ${tab === "leftovers" ? "btn-primary" : "btn-ghost"} touch-target`} onClick={() => setTab("leftovers")}>🧹 Retired Leftovers</button>
      </div>
      <Suspense fallback={<div style={{ padding: 20, color: "#94a3b8" }}>Loading…</div>}>
        {tab === "location" && <LocationProvidersTab />}
        {tab === "ringcentral" && <RingCentralTab />}
        {tab === "groups" && <TelegramGroupsTab />}
        {tab === "gmaps" && <GmapsTab />}
        {tab === "samsara" && <SamsaraTab />}
        {tab === "board" && <DispatcherBoardTab />}
        {tab === "bolpod" && <BolPodTab />}
          {tab === "ai" && <AiTab />}
        {tab === "notifications" && <NotificationsTab />}
        {tab === "reactions" && <AutoReactionsPanel />}
        {tab === "access" && <GroupAccessPanel />}
        {tab === "leftovers" && <RetiredLeftoversTab />}
      </Suspense>
    </div>
  );
}
