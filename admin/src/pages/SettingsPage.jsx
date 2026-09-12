import React, { Suspense, lazy, useState } from "react";

/**
 * Settings — tab shell. Each tab lives in ./settings/ and is lazy-loaded so
 * its code is fetched only when the tab is opened (smaller initial bundle).
 *
 * Secrets are write-only from the UI: the API returns only a masked "••••abcd"
 * hint and never the raw value. Leaving a key field blank on Save keeps the
 * stored value.
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
const RetiredLeftoversTab = lazy(() => import("./settings/RetiredLeftoversTab"));

export default function SettingsPage() {
  const [tab, setTab] = useState("location");
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
        {tab === "leftovers" && <RetiredLeftoversTab />}
      </Suspense>
    </div>
  );
}
